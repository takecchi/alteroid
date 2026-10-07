/**
 * 日誌の SSE を1本だけ張り、届いた出来事で画面を更新する。
 *
 * デーモンは**あらゆる追記**を `GET /journal/stream` に流す（`journal-bus.ts` が
 * `JournalStore.append` を包んでいる）。だから購読はここ1本でよく、種別ごとに
 * 対応する SWR キーを無効化すれば画面全体が生きたままになる。ポーリングを
 * 画面ごとに足すと、負荷の割に遅く、しかも「どこが古いのか」が分からなくなる。
 *
 * 再接続を自分で持っているのは、間にプロキシが挟まると無通信で黙って切られる
 * ことがあり、放っておくと画面は「静かなだけ」に見えるため（実際には死んでいる）。
 *
 * **デーモンは heartbeat を送る**（`packages/core/src/sse-heartbeat.ts`）。
 * **それでも再接続は要る。** heartbeat が塞ぐのは*サーバ側*が死んだ接続に
 * 気づけない穴で、切られた側がブラウザなら `EventSource` 相当の読みが終わるだけである
 * —— 誰かが張り直さなければ画面は生きたまま古くなる。
 */
import { useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';

import { useApiContext } from '../api';
import type { JournalEntry } from '@alteroid/logic';

import { isKeyOfType, KEY } from './queries';

/** 切れたときに待つ時間。指数で伸ばし、上限で頭打ちにする。 */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** 画面に出しておく直近の件数。 */
const RECENT_LIMIT = 200;

export type LiveStatus = 'connecting' | 'live' | 'offline';

export interface JournalLive {
  status: LiveStatus;
  /** 新しい順。接続してから届いたものだけ（履歴は `useJournal` が持つ）。 */
  recent: JournalEntry[];
  /**
   * 接続してから届いた出来事の**総数**（`RECENT_LIMIT` で切る前の値）。
   *
   * `recent` は `RECENT_LIMIT` 件で頭打ちにしてあるので、`recent.length` は
   * 「届いた全部のうち何件を出していないか」を答えられない — 200件を超えて
   * 届いた分だけ、`recent.length` は 200 に貼り付いたまま増えなくなる。
   * ここは上限を掛けずに1件ごと積むので、呼び出し側（`dashboard.tsx`）は
   * `receivedCount - (自分が画面に出した件数)` で本当の省略数を出せる。
   *
   * **optional にしてあるのは、この型を直に組み立てるテストがこの欄を持たなくても
   * 壊れないようにするためだけである。** `useJournalLive()` は必ずこれを返す。
   */
  receivedCount?: number;
}

export function useJournalLive(): JournalLive {
  const { client, baseUrl } = useApiContext();
  const { mutate } = useSWRConfig();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [recent, setRecent] = useState<JournalEntry[]>([]);
  const [receivedCount, setReceivedCount] = useState(0);

  // `mutate` を購読の effect の依存に入れると、その同一性が崩れた瞬間に
  // SSE を張り直すことになる。購読は張りっぱなしにしたいので ref 越しに読む
  // （更新は effect の中で行う。レンダー中に ref を書くと、React が並行に
  // 描き直したときに書き込みが失われうる）。
  const mutateRef = useRef(mutate);
  useEffect(() => {
    mutateRef.current = mutate;
  }, [mutate]);

  useEffect(() => {
    const controller = new AbortController();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    // 一度でも切れた（offline になった）後の最初の `open` が「繋ぎ直し」。
    // 初回の接続は各画面がマウント時に取るので取り直さない。この旗は effect ごと
    // なので、アンマウント→再マウント（新しい effect）では立たない。
    let lost = false;

    async function connect(): Promise<void> {
      setStatus('connecting');
      try {
        for await (const message of client.journalStream({ signal: controller.signal })) {
          attempt = 0;
          if (message.event === 'open') {
            setStatus('live');
            if (lost) {
              lost = false;
              refetchMounted(mutateRef.current);
            }
            continue;
          }
          const entry = message.data;
          setRecent((previous) => [entry, ...previous].slice(0, RECENT_LIMIT));
          setReceivedCount((previous) => previous + 1);
          invalidate(entry, mutateRef.current);
        }
      } catch {
        // 接続失敗も切断も同じ扱い（下の再接続へ）。中断だけは黙って抜ける。
      }
      if (stopped || controller.signal.aborted) return;

      setStatus('offline');
      lost = true;
      const wait = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
      attempt += 1;
      timer = setTimeout(() => void connect(), wait);
    }

    void connect();

    return () => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
    // 接続先が変わったら張り直す。
  }, [client, baseUrl]);

  return { status, recent, receivedCount };
}

/**
 * 繋ぎ直したとき、いま表示中（マウント中）のキーを1回取り直す。
 *
 * サーバは切れていた間の出来事を再生しないので、取り直さないと次の出来事・
 * フォーカス・遷移まで古いままになる。
 *
 * **データ引数なしの `mutate(述語)` は再検証だけである**（swr@2.5.1 の
 * `internalMutate`: `args.length < 3` なら `startRevalidate()` へ進むだけで、
 * キャッシュは書かない・捨てない）。再検証の窓口を持つのはマウント中のキー
 * だけなので、マウントされていないキーは何も起きず、次のマウントで取る。
 * 取り直している間も古い値は残る（空・スピナーに置き換わらない）。
 * `useSWRInfinite` の集約キー（`$inf$`）は SWR が述語から常に除外する
 * （`use-managers-window.ts` の doc を参照。頁1の再検証に便乗する作りなので、
 * 頁1が取り直されれば読み足した頁も追随する）。
 *
 * **除くもの。** `profile` / `mcpServers` は値に鍵が入りうるので、画面が開いている
 * あいだ勝手に運ばないと決めてある（`revalidateOnFocus: false`）。`authState`
 * （`useAuth`）は、取り直しが失敗すると画面全体が置き換わるうえ、
 * 認証の状態は SSE の再接続では変わらない。
 */
const REFETCH_EXCLUDED_TYPES = new Set(['profile', 'mcpServers', 'authState']);

function refetchMounted(mutate: ReturnType<typeof useSWRConfig>['mutate']): void {
  void mutate((key) => {
    const type =
      typeof key === 'object' && key !== null ? (key as { type?: unknown }).type : undefined;
    return !(typeof type === 'string' && REFETCH_EXCLUDED_TYPES.has(type));
  });
}

/**
 * 台帳（`stores.commitments`）を書く道具の名前。
 *
 * `commitment_list` は読むだけなので含めない（クローンが一覧を読むたびに画面が
 * 取り直すことになる）。数え上げの根拠は `@alteroid/core` の `CLONE_TOOL_NAMES` で、
 * `use-journal-live-commitments.test.tsx` がその配列の `commitment_` 始まりと突き合わせる
 * （道具が増えて名簿が古くなれば、そのテストが落ちる）。core の実行時コードは
 * 画面のバンドルへ持ち込まないので、ここは写しである。
 */
const LEDGER_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'commitment_open',
  'commitment_close',
  'commitment_close_many',
  'commitment_edit',
]);

/**
 * 届いた出来事に対応するキャッシュだけを落とす。
 *
 * **`default` の `never` 縛りで網羅性を型に縛ってある。** `schema.ts` の
 * `journalEntryTypeNames`（`satisfies Record<JournalEntryType, true>`）と
 * 同じ発想 — 種別を足してここへ分岐を足し忘れると、`default` の
 * `const exhaustive: never = entry;` が型エラーになる。
 *
 * **なぜ縛りが要るか。** この関数は戻り値を返さない（`void`）。
 * 戻り値を持つ関数（`tools.ts` の `renderJournalEntry` など）は case を1つ落とすと
 * 「関数の終わりに return が無い」で型検査が落ちるが、**TypeScript は switch 文
 * そのものの網羅性を検査しない**ので、`void` を返すここではその安全網が働かない。
 */
function invalidate(entry: JournalEntry, mutate: ReturnType<typeof useSWRConfig>['mutate']): void {
  // 日誌一覧は limit / type ごとにキーが違うので、type で束ねて全部落とす。
  void mutate((key) => isKeyOfType(key, 'journal'));

  switch (entry.type) {
    case 'escalation':
      void mutate((key) => isKeyOfType(key, 'approvals'));
      void mutate((key) => isKeyOfType(key, 'managers'));
      // マネージャー詳細・生ログも束で落とす。理由は下の `invalidateManagerDetail` に。
      invalidateManagerDetail(mutate);
      break;
    case 'memory_update':
      void mutate(KEY.memory);
      void mutate(KEY.memoryDoc(entry.slug));
      break;
    case 'daily_report':
      void mutate((key) => isKeyOfType(key, 'reports'));
      void mutate(KEY.report(entry.date));
      break;
    case 'tool_use':
      // **台帳を書く道具は、actor を問わず `commitments` を落とす。**
      // 台帳を動かすのは主にクローン自身で、その手の分は下の `isCloneActor` の関門で
      // `managers` を落とさないので、この分岐は関門より前に置く。
      if (LEDGER_WRITE_TOOLS.has(entry.tool)) {
        void mutate((key) => isKeyOfType(key, 'commitments'));
      }
      // **クローン自身の手の分では `managers` を落とさない。** 道具はクローンにも全部あり、
      // その実行も同じ `tool_use` として届く。マネージャーが1つも
      // 動いていないのに `/managers` と開いている詳細・生ログを取り直すと、
      // クローンが自分で作業しているあいだ画面が再取得を続けることになる。
      if (!isCloneActor(entry.actor)) {
        void mutate((key) => isKeyOfType(key, 'managers'));
        invalidateManagerDetail(mutate);
      }
      break;
    case 'exchange':
      if (entry.with === 'manager') {
        void mutate((key) => isKeyOfType(key, 'managers'));
        invalidateManagerDetail(mutate);
        // 委譲の開始・再開・終わりの報告。台帳の「進行中」（`activeManagerIds`）は
        // `GET /commitments` のたびに job 一覧から導かれるので、取り直さないと残る。
        void mutate((key) => isKeyOfType(key, 'commitments'));
      }
      if (entry.with === 'human') {
        // 返事（outbound）で「未着手」（`respondedAt`）が変わる。`buildCommitmentDerivations` が
        // 人間との `exchange` の履歴から導く。
        void mutate((key) => isKeyOfType(key, 'commitments'));
        void mutate((key) => isKeyOfType(key, 'conversations'));
        void mutate((key) => isKeyOfType(key, 'conversationUnreadCount'));
        // **一覧だけでなく本文も落とす。** ここを忘れると、会話の画面を開いた
        // ときに一度読んだ履歴のまま止まり、裏で進んだ往復が追いつかない。
        void mutate((key) => isKeyOfType(key, 'conversation'));
      }
      break;
    case 'external_event':
    case 'decision':
      break;
    // **キャッシュを落とす先が無い。** 日誌一覧（冒頭の `journal` の束）は
    // 既に落としているので十分 — この種別専用の画面・SWR キーは無い
    // （台帳 / `ManagerSummary` へは意図的に足していない。`manager.ts` の
    // `#onEvent` の doc を参照）。
    case 'worker_wait':
      break;
    // **`worker_wait` と同じ理由で落とす先が無い。** 台帳のページ（利用状況の
    // 集計）はターン単位ではなく日単位で読むので、`turn_usage` の到着ごとに
    // 取り直す必要はない。
    case 'turn_usage':
      break;
    // **`turn_usage` と同じ理由で落とす先が無い。** 文脈占有は
    // 消費の増分（`turn_usage`）とは独立の観測なので別の型として届くが、
    // 落とすべき画面・SWR キーが無いのは `turn_usage` と同じである。
    case 'context_usage':
      break;
    // **プールの状態（`GET /tokens`）を取り直す。** `/tokens` 画面
    // （`routes/tokens.tsx`）が現役の指名・冷却・失効をそのまま出しているので、
    // 回った直後に開いたままの画面を放置すると「前のトークンを現役として
    // 表示し続ける」——しかも日誌の一覧だけは新しくなるので、**同じ画面の
    // 中に2つの版が並ぶ**（読む側から見て、この食い違いは正常な観測に見えない）。
    case 'token_rotation':
      void mutate(KEY.tokens);
      break;
    // **落とす先が無い。** `worker_wait` / `turn_usage` と同じ理由——この種別は
    // 日誌にしか現れない（`schema.ts` の `subagent_stall` の doc。会話・記憶・
    // 台帳のどれの状態も動かさない、作業者が自分で起こした背景処理を残したまま
    // 畳もうとした、という observation だけである）。この種別専用の画面・SWR
    // キーは無いので、冒頭で束にした日誌一覧の無効化だけで十分。**惰性で
    // `exchange`（マネージャー・生ログを束で落とす）と同じにしないこと** ——
    // `subagent_stall` はマネージャーの詳細や生ログの中身を変える出来事ではない。
    case 'subagent_stall':
      break;
    // **落とす先が無い。**`turn_usage` / `context_usage` と
    // 同じ理由 —— 受信箱の流量は器の記帳で、この種別専用の画面・SWR キーは
    // 無い。冒頭で束にした日誌一覧の無効化だけで足りる。
    case 'inbox_flow':
      break;
    // **落とす先が無い。**進捗の頁（`/progress`）は 30 秒ごとに取り直す
    // ので、この種別専用の無効化は要らない。冒頭で束にした日誌一覧の無効化だけで足りる。
    case 'github_observation':
      break;
    default: {
      // 網羅性チェック本体。ここへ来る値があれば、上の case が
      // `JournalEntryType` の全種別を尽くしていない（型エラーになる）。
      //
      // **実行時には何もしない。投げないこと。** この関数は SSE の
      // `for await` の中から呼ばれ、その外側の `catch` は「接続失敗も切断も
      // 同じ扱い」で再接続へ落ちる（`connect()`）。だから1件の未知の種別で
      // 投げると、線は生きているのに購読が切れ、`offline` 表示のまま指数
      // バックオフで繋ぎ直し続けることになる — **このファイルの冒頭が塞いだ
      // はずの「画面が静かなだけに見える（実際には死んでいる）」そのもの**で
      // ある。しかも起きる条件は「デーモンが新しい種別を流し、古い bundle を
      // 開いたままのブラウザがそれを受ける」で、器と画面は別に更新されるので
      // 普通に起こる。
      //
      // 落とす先が無いだけなので、何もしないのが正しい（日誌一覧の無効化は
      // この switch の手前で既に済んでいる）。**型で気づける形は残したまま、
      // 実行時の被害だけを消す**のがここの狙いである。
      const exhaustive: never = entry;
      void exhaustive;
      break;
    }
  }
}

/**
 * その `tool_use` がクローン自身の手か（`clone` / `clone:sub:<agent>` /
 * `clone:distill`）。
 *
 * **判定の正本は `@alteroid/core` の `isCloneActor` である。** ここに写しがあるのは
 * 画面のバンドルへ core の実行時コード（zod・`node:*` を引く）を持ち込まないため
 * だけで、判断を分けたいからではない。**枝を増やすときは両方直すこと** — core 側の
 * docstring にも同じことが書いてある。
 */
function isCloneActor(actor: string): boolean {
  return actor === 'clone' || actor.startsWith('clone:');
}

/**
 * マネージャー詳細（`KEY.manager(id)`）と生ログ（`KEY.transcript(id)`）を
 * **id を指定せず束で**落とす。
 *
 * `tool_use.actor` は `manager:<id>` / `worker:<id>:<agent>` で id を取り出せるが、
 * `exchange(with:'manager')` には manager id を持つフィールドが無い。種別によって
 * 精度が変わる（tool_use だけ id 指定、他は束）形にすると考えることが増えて
 * 漏れやすい。キャッシュに載っているのは開いている詳細画面の分だけなので、
 * 束で落としても安い — だから常に束で統一する。
 */
function invalidateManagerDetail(mutate: ReturnType<typeof useSWRConfig>['mutate']): void {
  void mutate((key) => isKeyOfType(key, 'manager'));
  void mutate((key) => isKeyOfType(key, 'transcript'));
}

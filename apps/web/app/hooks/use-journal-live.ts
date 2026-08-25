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
 * **デーモンは heartbeat を送る**（`packages/core/src/sse-heartbeat.ts`。かつて
 * ここには「送らないため」と書いてあった）。**それでも再接続は要る。** heartbeat が
 * 塞ぐのは*サーバ側*が死んだ接続に気づけない穴で、切られた側がブラウザなら
 * `EventSource` 相当の読みが終わるだけである —— 誰かが張り直さなければ画面は
 * 生きたまま古くなる。heartbeat が変えたのは「気づくまでの時間」であって、
 * 「気づいた後に誰が張り直すか」ではない。
 */
import { useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';

import { useApiContext } from '~/lib/api';
import type { JournalEntry } from '~/lib/types';

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
}

export function useJournalLive(): JournalLive {
  const { client, baseUrl } = useApiContext();
  const { mutate } = useSWRConfig();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [recent, setRecent] = useState<JournalEntry[]>([]);

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

    async function connect(): Promise<void> {
      setStatus('connecting');
      try {
        for await (const message of client.journalStream({ signal: controller.signal })) {
          attempt = 0;
          if (message.event === 'open') {
            setStatus('live');
            continue;
          }
          const entry = message.data;
          setRecent((previous) => [entry, ...previous].slice(0, RECENT_LIMIT));
          invalidate(entry, mutateRef.current);
        }
      } catch {
        // 接続失敗も切断も同じ扱い（下の再接続へ）。中断だけは黙って抜ける。
      }
      if (stopped || controller.signal.aborted) return;

      setStatus('offline');
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

  return { status, recent };
}

/**
 * 届いた出来事に対応するキャッシュだけを落とす。
 *
 * **`default` の `never` 縛りで網羅性を型に縛ってある。** `schema.ts` の
 * `journalEntryTypeNames`（`satisfies Record<JournalEntryType, true>`）と
 * 同じ発想 — 種別を足してここへ分岐を足し忘れると、`default` の
 * `const exhaustive: never = entry;` が型エラーになる。
 *
 * **なぜ縛りが要ったか。** この関数は戻り値を返さない（`void`）。
 * `tools.ts` の `renderJournalEntry` や `queries.ts` の
 * `summarizeJournalEntry`、`dropped-record.ts` の `journalEntryShape` は
 * いずれも戻り値を持つ関数で、case を1つ落とすと「関数の終わりに
 * return が無い（戻り値型に `undefined` を含まない）」で型検査が自然に
 * 落ちる。**しかし TypeScript は switch 文そのものの網羅性を検査しない**
 * ので、`void` を返すここではその安全網が働かず、種別を足して分岐を
 * 忘れても型では気づけなかった（実際、`worker_wait` を足したときは
 * 明示的に `case 'worker_wait': break;` を書いて対応していたが、この
 * switch 自体は次に種別が増えても黙って通っていた）。
 */
function invalidate(entry: JournalEntry, mutate: ReturnType<typeof useSWRConfig>['mutate']): void {
  // 日誌一覧は limit / type ごとにキーが違うので、type で束ねて全部落とす。
  void mutate((key) => isKeyOfType(key, 'journal'));

  switch (entry.type) {
    case 'escalation':
      void mutate((key) => isKeyOfType(key, 'approvals'));
      void mutate(KEY.managers);
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
      // **クローン自身の手の分では落とさない。** 道具はクローンにも全部あり
      // （#32）、その実行も同じ `tool_use` として届く。マネージャーが1つも
      // 動いていないのに `/managers` と開いている詳細・生ログを取り直すと、
      // クローンが自分で作業しているあいだ画面が再取得を続けることになる。
      if (!isCloneActor(entry.actor)) {
        void mutate(KEY.managers);
        invalidateManagerDetail(mutate);
      }
      break;
    case 'exchange':
      if (entry.with === 'manager') {
        void mutate(KEY.managers);
        invalidateManagerDetail(mutate);
      }
      if (entry.with === 'human') {
        void mutate((key) => isKeyOfType(key, 'conversations'));
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
    // **落とす先が「まだ」無い。** プールの状態（現役の指名・冷却・失効）は
    // `GET /tokens` に在るのに、**この画面群にはそれを出す頁が1つも無い**
    // （CLI と HTTP からしか見えない ＝ PRD「片方でしかできないことを作らない」に
    // 反している既存の穴。この PR が作ったものではない）。
    //
    // **頁を足すときは、ここに `void mutate(KEY.tokens)` を足すこと。** 足さないと
    // 「回った直後に開いた画面が、前のトークンを現役として表示し続ける」——
    // しかも日誌の一覧だけは更新されるので、**同じ画面の中で2つの版が並ぶ。**
    case 'token_rotation':
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
 * マネージャー詳細（`KEY.manager(id)`）と生ログ（`KEY.transcript(id)`）を
 * **id を指定せず束で**落とす。
 *
 * `tool_use.actor` は `manager:<id>` / `worker:<id>:<agent>` で id を取り出せるが、
 * `exchange(with:'manager')` には manager id を持つフィールドが無い。種別によって
 * 精度が変わる（tool_use だけ id 指定、他は束）形にすると考えることが増えて
 * 漏れやすい。キャッシュに載っているのは開いている詳細画面の分だけなので、
 * 束で落としても安い — だから常に束で統一する。
 */
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

function invalidateManagerDetail(mutate: ReturnType<typeof useSWRConfig>['mutate']): void {
  void mutate((key) => isKeyOfType(key, 'manager'));
  void mutate((key) => isKeyOfType(key, 'transcript'));
}

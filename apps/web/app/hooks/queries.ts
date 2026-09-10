/**
 * 読み取りの hooks。
 *
 * SWR のキーは**文字列ではなくオブジェクト**にしてある。文字列だと連結の順番や
 * 区切りで衝突しうるし、何のキャッシュなのかが読めない。`{type: ...}` にしておけば
 * `mutate` 側でも同じ形で指せる（`app/hooks/use-journal-live.ts`）。
 */
import useSWR from 'swr';

import { unwrap, useApi } from '~/lib/api';
import type {
  JournalEntry,
  JournalEntryType,
  ManagerStatus,
  UsageLayer,
  UsageSite,
} from '~/lib/types';

export interface UsageQuery {
  from?: string;
  to?: string;
  managerId?: string;
  /**
   * 誰が（層）・どこで（場所）。**4つの口すべてに同じ絞り込みを置く**ため、
   * 画面にも API・CLI・クローンの道具と同じものがある（PRD「インターフェース」）。
   */
  layer?: UsageLayer;
  site?: UsageSite;
}

/**
 * `GET /managers` の絞り込みと窓（issue #670）。
 *
 * **全部 optional で、1つも渡さない呼びはクエリ文字列を1文字も付けない。**
 * デーモン側が opt-in（渡さなければ応答が1バイトも変わらない）なので、
 * 画面側でも「渡さない」を渡せる形にしておく必要がある——ここで既定値を
 * 埋めると、`dashboard.tsx` の `useManagers()`（引数なし）が黙って窓の
 * 掛かった呼びに変わる。
 *
 * **`status` は配列で受けてカンマ区切りへ畳む**（`useJournal` の `types` と
 * 同じ形）。**空配列は「絞らない」** ——`status=` を送るのと同じ結果に
 * なるが、そもそもパラメタを付けない側に倒す（クエリ文字列が空のままなら、
 * 上の opt-in がそのまま効く）。
 *
 * **錨は `managerId` ＋ `startedAt` の組で渡す**（片方だけは 400）。値は
 * 応答に載っている `managerId` / `startedAt` をそのまま使う——封筒
 * （`total` / `nextCursor`）は無い（`apps/daemon/src/app.ts` の
 * `managersQuery` の doc）。
 */
export interface ManagersQuery {
  status?: readonly ManagerStatus[];
  limit?: number;
  after?: { managerId: string; startedAt: string };
}

/**
 * SWR のキーはオブジェクトなので、`type` を見て束で指す。
 *
 * `use-journal-live.ts`（無効化）と `mutations.ts`（自分の送信の即時反映）の
 * 両方から使うのでここに置く。キーの形を決めているのがこのファイルなので、
 * その判定もここに置くのが自然（重複させない）。
 */
export function isKeyOfType(key: unknown, type: string): boolean {
  return typeof key === 'object' && key !== null && (key as { type?: unknown }).type === type;
}

export const KEY = {
  health: { type: 'health' } as const,
  /**
   * **窓ごとに別のキーになる**（issue #670）。かつてここは
   * `{ type: 'managers' }` の1つだけで、`mutate(KEY.managers)` が呼べていた。
   *
   * **⚠️ その形はもう使えない。** 関数になった `KEY.managers` を
   * `mutate(KEY.managers)` へ渡すと、SWR は**キーではなく絞り込みの述語**
   * として受け取る（`mutate(fn)` の形）。述語は毎回真値のオブジェクトを
   * 返すので、**キャッシュの全キーが落ちる**——型検査は通り、画面は
   * 「よく効いている」ように見えるので、気づく契機が無い。
   *
   * ⟹ **落とすときは必ず束で指すこと**（`mutate((key) => isKeyOfType(key,
   * 'managers'))`）。`journal` / `reports` / `conversations` / `approvals` が
   * 既にそうしている形と同じである。
   */
  managers: (query: ManagersQuery = {}) =>
    ({
      type: 'managers',
      status: [...(query.status ?? [])].join(','),
      limit: query.limit,
      afterId: query.after?.managerId,
      afterStartedAt: query.after?.startedAt,
    }) as const,
  manager: (id: string) => ({ type: 'manager', id }) as const,
  transcript: (id: string) => ({ type: 'transcript', id }) as const,
  approvals: (pending: boolean) => ({ type: 'approvals', pending }) as const,
  /**
   * ある会話に上がった確認だけの束（issue #782 の2・3）。
   *
   * **`type` は `approvals` のまま揃えてある。** `use-journal-live.ts` の
   * `invalidate()` は `escalation` が届くと `isKeyOfType(key, 'approvals')`
   * で束ねて無効化する——ここだけ別の `type` にすると、確認に答えが付いた
   * ときにこのキャッシュだけ古いまま取り残される。
   */
  conversationApprovals: (conversationId: string) =>
    ({ type: 'approvals', pending: false, conversationId }) as const,
  commitments: (includeClosed: boolean) => ({ type: 'commitments', includeClosed }) as const,
  reports: (limit: number) => ({ type: 'reports', limit }) as const,
  report: (date: string) => ({ type: 'report', date }) as const,
  journal: (limit: number, types: string) => ({ type: 'journal', limit, types }) as const,
  schedule: { type: 'schedule' } as const,
  usage: (query: UsageQuery) => ({ type: 'usage', ...query }) as const,
  memory: { type: 'memory' } as const,
  memoryDoc: (slug: string) => ({ type: 'memoryDoc', slug }) as const,
  conversations: (limit: number) => ({ type: 'conversations', limit }) as const,
  conversation: (id: string) => ({ type: 'conversation', id }) as const,
  runners: { type: 'runners' } as const,
  tokens: { type: 'tokens' } as const,
  dropped: { type: 'dropped' } as const,
};

/** デーモンが応答するか。接続先が合っているかの唯一の手がかりでもある。 */
export function useHealth() {
  const api = useApi();
  return useSWR(KEY.health, () => api.api.GET('/health').then(unwrap), {
    // 繋がらないときに黙って諦めない（接続先を直したらすぐ復帰してほしい）。
    errorRetryInterval: 5000,
    refreshInterval: 30_000,
  });
}

/**
 * 委譲先マネージャーの一覧（issue #670 で絞り込みと窓が付いた）。
 *
 * **引数なしの呼びは、クエリ文字列を1文字も付けない。** デーモン側が opt-in
 * なので、`dashboard.tsx` の `useManagers()` はこの変更の前と1バイトも同じ
 * 応答を受ける（`managersToQuery` がそれを支えている——空の欄を落とすのは
 * 見た目の整えではなく、この保証そのものである）。
 *
 * **空の `query` を渡しても URL は変わらない。** `openapi-fetch` の
 * `createFinalURL` は `querySerializer(params.query ?? {})` の結果が空文字なら
 * `?` そのものを付けない（`openapi-fetch@0.17.0` の `createFinalURL`）。
 * ⟹ ここで `params` を条件付きで外す必要は無い。**この主張は
 * `managers.test.tsx` の「引数なしの呼びは `?` を付けない」で測ってある**
 * ——上流の実装に乗った主張なので、版が上がったら歯の側が落ちる。
 */
export function useManagers(query: ManagersQuery = {}) {
  const api = useApi();
  const params = managersToQuery(query);
  return useSWR(KEY.managers(query), () =>
    api.api.GET('/managers', { params: { query: params } }).then(unwrap),
  );
}

/**
 * `ManagersQuery` を `GET /managers` のクエリへ畳む。
 *
 * **空の欄は付けない**（`undefined` の欄すら作らない）。これは見た目の整えでは
 * なく、**デーモン側の opt-in を成り立たせているものである**——あちらは
 * 生のクエリ（`c.req.query('limit') !== undefined`）で「渡されたか」を判定する
 * ので、空の値を送った時点で窓の掛かった呼びに化ける。
 *
 * **`status` の空配列は「絞らない」。** `status=` を送っても同じ結果になる
 * （デーモン側が空を「渡さなかった」と同じに扱う）が、送らない側に倒せば
 * 上の opt-in がそのまま効く。
 */
export function managersToQuery(query: ManagersQuery): {
  status?: string;
  limit?: number;
  afterId?: string;
  afterStartedAt?: string;
} {
  const status = [...(query.status ?? [])].join(',');
  return {
    ...(status === '' ? {} : { status }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.after === undefined
      ? {}
      : { afterId: query.after.managerId, afterStartedAt: query.after.startedAt }),
  };
}

export function useManager(id: string) {
  const api = useApi();
  return useSWR(KEY.manager(id), ({ id }) =>
    api.api.GET('/managers/{id}', { params: { path: { id } } }).then(unwrap),
  );
}

/**
 * 生ログ。`text/plain` の JSONL がそのまま返る。
 *
 * `null` を渡すと取りに行かない（SWR の条件付き取得）。**空文字を渡して
 * `/managers//transcript` を叩かせない** — 404 が「無い」なのか「聞き方が
 * 間違っている」なのか区別できなくなる。
 */
export function useManagerTranscript(id: string | null) {
  const api = useApi();
  return useSWR(id === null ? null : KEY.transcript(id), async ({ id }) => {
    const result = await api.api.GET('/managers/{id}/transcript', {
      params: { path: { id } },
      parseAs: 'text',
    });
    return unwrap(result);
  });
}

/**
 * 承認待ちの一覧。
 *
 * **`order` を明示して呼ぶ。窓（`limit` / `cursor`）は作らない。**
 *
 * 直しているのは**並びの不安定さ**であって、件数の可視化ではない。ここは全件を
 * 受け取っているので、応答へ載る `total` は受け取った配列の長さと必ず一致する
 * 冗長な値である（**だから画面には出さない** — 出すと「意味の在る数」に見える）。
 *
 * **何が不安定だったか。** `order` / `limit` / `cursor` のどれも渡さない呼びは、
 * デーモンがストアの生の並びをそのまま返す（`apps/daemon/src/app.ts` の
 * `/approvals`）。そしてその生の並びは**実装ごとに違う**:
 *
 * - `packages/storage-fs` / `packages/core/src/testing.ts` — 配列・Map の挿入順。
 *   `putApproval` が既存の id を**末尾へ動かす**ので、回答するたびに並びが変わる
 * - `packages/storage-pg` — `orderBy(asc(approvals.createdAt))` で既に作成順
 *
 * ⟹ **同じ画面が、どの永続化層で動いているかによって違う順で出ていた。**
 * `order` を明示すると、デーモンが `(createdAt, id)` の昇順へ揃えるので
 * （`compareApprovalPagingKey`）、**実装によらず同じ順になる。**
 *
 * **既定値と同じ `'asc'` を送っている。** 並びの意味は変えず、「渡した」という
 * 事実だけで封筒と整列を有効にする（デーモン側は生のクエリで opt-in を判定する）。
 */
export function useApprovals(pending = true) {
  const api = useApi();
  return useSWR(KEY.approvals(pending), ({ pending }) =>
    api.api
      .GET('/approvals', {
        params: { query: { pending: pending ? 'true' : 'false', order: 'asc' } },
      })
      .then(unwrap),
  );
}

/**
 * ある会話に上がった確認（`ask_human`）だけの一覧（issue #782 の2）。
 *
 * **`chat.tsx` がチャットの履歴へ質問・回答を織り込むために読む。** 質問は
 * `createdAt` の位置へ、回答は `answeredAt` の位置へ——両方とも `chat.tsx`
 * の `historyLines` が担う。
 *
 * **`pending=false` を渡す。** 答えた分も含めて取らないと、回答済みの確認が
 * 画面をリロードした瞬間に「まだ返答が無い」へ戻って見える——新しい「嘘の
 * 『無い』」を作ってしまう（不変条件 A）。
 *
 * `null` なら取りに行かない（まだ会話 id が無い＝新しい会話。`useConversation`
 * と同じ形）。
 */
export function useConversationApprovals(conversationId: string | null) {
  const api = useApi();
  return useSWR(
    conversationId === null ? null : KEY.conversationApprovals(conversationId),
    ({ conversationId }) =>
      api.api
        .GET('/approvals', {
          params: { query: { pending: 'false', order: 'asc', conversationId } },
        })
        .then(unwrap),
  );
}

/**
 * 引き受けたまま終わっていない仕事の台帳。
 *
 * **承認待ちとは別のものである。** あちらは「クローンが人間の答えを待って止まって
 * いる」で、こちらは「頼まれたことがまだ片付いていない」。止まっていなくても
 * 片付いていない仕事はあるので、片方で他方は代用できない。
 *
 * 並びはデーモンが決める（未了が古い順、片付いたものが新しい順で後ろ。
 * `packages/core/src/store.ts` の `CommitmentStore`）。**画面で並べ直さない** —
 * 並べ直すと、齢の見え方が CLI・クローンとここで食い違う。
 */
export function useCommitments(includeClosed = false) {
  const api = useApi();
  return useSWR(KEY.commitments(includeClosed), ({ includeClosed }) =>
    api.api
      .GET('/commitments', {
        params: { query: { includeClosed: includeClosed ? 'true' : 'false' } },
      })
      .then(unwrap),
  );
}

export function useReports(limit = 7) {
  const api = useApi();
  return useSWR(KEY.reports(limit), ({ limit }) =>
    api.api.GET('/reports', { params: { query: { limit } } }).then(unwrap),
  );
}

export function useReport(date: string) {
  const api = useApi();
  return useSWR(KEY.report(date), ({ date }) =>
    api.api.GET('/reports/{date}', { params: { path: { date } } }).then(unwrap),
  );
}

export function useJournal(limit = 100, types: readonly JournalEntryType[] = []) {
  const api = useApi();
  const joined = types.join(',');
  return useSWR(KEY.journal(limit, joined), ({ limit, types }) =>
    api.api
      .GET('/journal', {
        params: { query: { limit, ...(types === '' ? {} : { type: types }) } },
      })
      .then(unwrap),
  );
}

export function useSchedule() {
  const api = useApi();
  return useSWR(KEY.schedule, () => api.api.GET('/schedule').then(unwrap), {
    refreshInterval: 30_000,
  });
}

/**
 * 利用状況（いくら使ったか）。経路は `GET /usage` の1本だけで、CLI・chat の
 * `/usage`・クローンの `usage_read` と同じものを見る（`apps/daemon/src/app.ts`
 * 「経路は1本だけにする」）。
 */
export function useUsage(query: UsageQuery = {}) {
  const api = useApi();
  return useSWR(KEY.usage(query), ({ from, to, managerId, layer, site }) =>
    api.api
      .GET('/usage', {
        params: {
          query: {
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...(managerId === undefined ? {} : { managerId }),
            ...(layer === undefined ? {} : { layer }),
            ...(site === undefined ? {} : { site }),
          },
        },
      })
      .then(unwrap),
  );
}

export function useMemoryDocuments() {
  const api = useApi();
  return useSWR(KEY.memory, () => api.api.GET('/memory').then(unwrap));
}

export function useMemoryDocument(slug: string) {
  const api = useApi();
  return useSWR(KEY.memoryDoc(slug), ({ slug }) =>
    api.api.GET('/memory/{slug}', { params: { path: { slug } } }).then(unwrap),
  );
}

export function useConversations(limit = 30) {
  const api = useApi();
  return useSWR(KEY.conversations(limit), ({ limit }) =>
    api.api.GET('/conversations', { params: { query: { limit } } }).then(unwrap),
  );
}

/** `null` なら取りに行かない（まだ会話 id が無い＝新しい会話）。 */
export function useConversation(id: string | null) {
  const api = useApi();
  return useSWR(id === null ? null : KEY.conversation(id), ({ id }) =>
    api.api.GET('/conversations/{id}', { params: { path: { id } } }).then(unwrap),
  );
}

export function useRunners() {
  const api = useApi();
  return useSWR(KEY.runners, () => api.api.GET('/runners').then(unwrap));
}

/**
 * 認証トークンのプールと、回す契機・冷却の設定（`GET /tokens`）。
 *
 * **alteroid を使う許可があれば読める**（2026-09-06 の同格化で `requireOperator` が
 * 外れた。それ以前は実行環境の持ち主だけだった）。読み取り専用（`PUT /tokens` は
 * この画面からは呼ばない）。
 */
export function useTokens() {
  const api = useApi();
  return useSWR(KEY.tokens, () => api.api.GET('/tokens').then(unwrap));
}

/**
 * 握り潰しの跡（`GET /dropped`）。**資格は認証のみ**（`/journal` `/managers`
 * `/conversations` と同じ強さ。`requireOperator` は付いていない——
 * `apps/daemon/src/app.ts` の `GET /dropped` の doc）。読み取り専用。
 */
export function useDropped() {
  const api = useApi();
  return useSWR(KEY.dropped, () => api.api.GET('/dropped').then(unwrap));
}

/** 日誌エントリを人間が読む1行に潰す（一覧と通知で同じ文言を使うため）。 */
export function summarizeJournalEntry(entry: JournalEntry): string {
  switch (entry.type) {
    case 'exchange':
      return `${entry.with} ${entry.role === 'inbound' ? '←' : '→'} ${entry.text}`;
    case 'decision':
      return `${entry.decision}（根拠: ${entry.grounds}）`;
    case 'escalation':
      return entry.answeredAt === undefined
        ? `確認: ${entry.question}`
        : `回答済: ${entry.question}`;
    case 'tool_use':
      return `${entry.actor} が ${entry.tool}`;
    case 'memory_update': {
      // **単位はバイトである**（`schema.ts` の `bytesBefore`/`bytesAfter` の
      // doc）。`entry.summary` には文字数が埋め込まれていることがある
      // （`memory_delete` の「削除直前 N 文字」）ので、バイトの注記は
      // `:` の手前——`cause`/`action` と同じ構造化された括弧の中——に置き、
      // 自由文の `summary` はコロンの後ろへ分ける（1行の中でも、単位の
      // 混ざる場所を分ける。#318 のコメントで実際に読み違いが起きている）。
      //
      // `action` と `bytesBefore`/`bytesAfter` は `optional`——この区別が
      // 導入される前の古いエントリは両方とも無い。無いことを `0` として
      // 出すと「変化が無かった」と読めてしまう（AGENTS.md の地雷表「取れない
      // 軸に 0 の行を作る」）ので、値が無いときは「不明」と明示し、
      // 黙って省かない（省くと、バイトが出ている行と混ざったときに
      // 「変化なし」に読める）。
      const action = entry.action === undefined ? '' : `/${entry.action}`;
      const bytes =
        entry.bytesBefore === undefined || entry.bytesAfter === undefined
          ? '前後バイト数不明（旧形式）'
          : `${entry.bytesBefore}→${entry.bytesAfter} バイト`;
      return `記憶 ${entry.slug} を更新（${entry.cause}${action} / ${bytes}）: ${entry.summary}`;
    }
    case 'daily_report':
      // **印の付いた行を「日報」と呼ばない**（`schema.ts` の `unavailable` の doc）。
      // 日誌の一覧は日報の有無を人間が拾い読みする面でもあるので、ここが
      // 「2026-08-20 の日報」としか言わないと、書けなかった日が書けた日と同じ顔で
      // 並ぶ。理由まで出すのは日報の面の仕事なので、ここでは印だけを言う。
      return entry.unavailable === undefined
        ? `${entry.date} の日報`
        : `⚠ ${entry.date} の日報は作れなかった: ${entry.unavailable}`;
    case 'external_event':
      return `${entry.source}: ${entry.summary}`;
    case 'worker_wait': {
      const cause = entry.byCause;
      return (
        `作業者 ${entry.tasks} 体を待つあいだに ${entry.turns} ターン` +
        `（通知 ${cause.notification} / 自己継続 ${cause.continuation} / 話しかけ ${cause.input}）。` +
        `うち ${entry.toolless} ターンは道具を1つも動かしていない` +
        (entry.settled ? '' : '（区間は閉じずに終わった）')
      );
    }
    case 'turn_usage': {
      // **キャッシュの書き直しを潰さない**（read/write を分けたまま見せる。
      // 潰すと「キャッシュ書き直しに払っているか」が推測に戻る）。数え直しの
      // 印は隠さない — 印の行を一覧から見えなくすると誤読を招く。
      const models = Object.entries(entry.models);
      const totalCost = models.reduce((sum, [, totals]) => sum + totals.costUsd, 0);
      const cacheWrite = models.reduce(
        (sum, [, totals]) => sum + totals.cacheCreationInputTokens,
        0,
      );
      const cacheRead = models.reduce((sum, [, totals]) => sum + totals.cacheReadInputTokens, 0);
      // **文脈の占有と compaction も1行に出す。** 日誌には在るのに、この画面も
      // クローンの `journal_read` も出していなかった欄である（`schema.ts` の
      // `turn_usage.contextUsage`）。「消費が増え続けている」の原因が
      // 「毎ターンの文脈が育っている」なのかを、**この画面だけで見分けられる
      // ようにする**——出さないでいると、答えるのに DB へ直接 SQL を投げる
      // ことになる（2026-09-08 に実際にそうなった）。
      const context = entry.contextUsage;
      const contextNote =
        context === undefined || context.percentage === undefined
          ? ''
          : ` 文脈 ${context.percentage}%` +
            (context.totalTokens === undefined ? '' : `（${context.totalTokens} トークン）`);
      const compactionNote =
        entry.compactions === undefined || entry.compactions.length === 0
          ? ''
          : ` ⚠ compaction ${entry.compactions.length} 回`;
      return (
        `[${entry.layer}/${entry.site}] ${entry.managerId} 1ターン $${totalCost.toFixed(4)}` +
        `（cache read=${cacheRead} write=${cacheWrite}）` +
        contextNote +
        compactionNote +
        (entry.reset === undefined ? '' : ' ⚠ 数え直しを挟んだ回（models は差分ではない）')
      );
    }
    case 'token_rotation':
      // **`text` をそのまま出す。** ここで組み直すと、同じ事実を読む4つの面
      // （stderr・この画面・クローンの `journal_read`・CLI）で言い方が分かれる。
      // 文言の持ち主は `describeTokenRotation` 1つである。
      //
      // **見出しの `event` は落とさない** — 一覧の1行しか読まない人が、
      // `exhausted`（全層が止まる）と `not_rotated`（正常）を見分けられなくなる。
      return `[${entry.event}] ${entry.text}`;
    case 'subagent_stall': {
      // **`token_rotation` と違い、`text` をそのまま出さない。** `entry.text`
      // は `runner.ts` の `#onSubagentStop` が組み立てた `note.text` そのままで、
      // 残っている背景処理の一覧（`taskLines`）と「この行が出ないことは空転が
      // 無かったを意味しない」という断り書きを含む複数行である——`token_rotation`
      // の `text`（`describeTokenRotation` が作る本当の1行）とは密度が違う。
      // この関数の役目は「一覧と通知で同じ文言を使うための、潰した1行」なので、
      // 丸ごと連結すると一覧の1行がこの種別だけ極端に長くなる。ここでは
      // `entry.text` に既に書かれている事情を、必要な欄だけ拾って組み直す。
      //
      // **`outcome` の2値は潰さない** — `woken`（起こし直した。まだ委譲が進む
      // 見込みがある）と `limit_reached`（上限に達して起こし直さなかった。
      // 自動では再開しない＝人が要る）は性質が違う
      // （`schema.ts` の `subagent_stall.outcome` の doc と同じ理由）。
      const agentType = entry.agentType === undefined ? '' : `/${entry.agentType}`;
      const outcome =
        entry.outcome === 'woken'
          ? `起こし直した（${entry.wakeupCount}回目）`
          : `上限に達し、起こし直さなかった（要対応。既に${entry.wakeupCount}回起こし直し済み）`;
      return (
        `作業者 ${entry.agentId}${agentType} が自分で起こした背景処理を ` +
        `${entry.ownedTaskCount}件 残したまま畳もうとした（セッション全体 ${entry.sessionTaskCount}件）: ` +
        outcome
      );
    }
  }
}

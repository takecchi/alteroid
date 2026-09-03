/**
 * 読み取りの hooks。
 *
 * SWR のキーは**文字列ではなくオブジェクト**にしてある。文字列だと連結の順番や
 * 区切りで衝突しうるし、何のキャッシュなのかが読めない。`{type: ...}` にしておけば
 * `mutate` 側でも同じ形で指せる（`app/hooks/use-journal-live.ts`）。
 */
import useSWR from 'swr';

import { unwrap, useApi } from '~/lib/api';
import type { JournalEntry, JournalEntryType, UsageLayer, UsageSite } from '~/lib/types';

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
  managers: { type: 'managers' } as const,
  manager: (id: string) => ({ type: 'manager', id }) as const,
  transcript: (id: string) => ({ type: 'transcript', id }) as const,
  approvals: (pending: boolean) => ({ type: 'approvals', pending }) as const,
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

export function useManagers() {
  const api = useApi();
  return useSWR(KEY.managers, () => api.api.GET('/managers').then(unwrap));
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
 * **実行環境の持ち主だけ**（`requireOperator`）——`account grant` を通しただけの
 * アカウントには 403 が返る。読み取り専用（`PUT /tokens` はこの画面からは呼ばない）。
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
      return (
        `[${entry.layer}/${entry.site}] ${entry.managerId} 1ターン $${totalCost.toFixed(4)}` +
        `（cache read=${cacheRead} write=${cacheWrite}）` +
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
  }
}

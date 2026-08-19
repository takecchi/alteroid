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

export function useApprovals(pending = true) {
  const api = useApi();
  return useSWR(KEY.approvals(pending), ({ pending }) =>
    api.api
      .GET('/approvals', { params: { query: { pending: pending ? 'true' : 'false' } } })
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
    case 'memory_update':
      return `記憶 ${entry.slug} を更新（${entry.cause}）: ${entry.summary}`;
    case 'daily_report':
      return `${entry.date} の日報`;
    case 'external_event':
      return `${entry.source}: ${entry.summary}`;
  }
}

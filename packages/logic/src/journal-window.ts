// `@alteroid/core` 本体ではなく `journal-search` から取る: 本体は値を1つ import するだけでサーバ専用の層ごとバンドルへ入る。
import { matchesJournalSearch } from '@alteroid/core/journal-search';

import type { JournalEntry } from './types.js';

export interface MergeResult {
  entries: JournalEntry[];
  freshCount: number;
}

// 既知の id を除いた新しい行だけを、前か後ろに積む。新しい行が無ければ元の配列をそのまま返す。
function mergeEntries(
  existing: JournalEntry[],
  incoming: JournalEntry[],
  side: 'front' | 'back',
): MergeResult {
  if (incoming.length === 0) return { entries: existing, freshCount: 0 };
  const known = new Set(existing.map((entry) => entry.id));
  const fresh = incoming.filter((entry) => !known.has(entry.id));
  if (fresh.length === 0) return { entries: existing, freshCount: 0 };
  return {
    entries: side === 'front' ? [...fresh, ...existing] : [...existing, ...fresh],
    freshCount: fresh.length,
  };
}

export function mergeFront(existing: JournalEntry[], incoming: JournalEntry[]): MergeResult {
  return mergeEntries(existing, incoming, 'front');
}

export function mergeBack(existing: JournalEntry[], incoming: JournalEntry[]): MergeResult {
  return mergeEntries(existing, incoming, 'back');
}

// daemon の zod スキーマを import せず写す: `apps/web` は daemon のスキーマに依存しない設計のため。daemon の上限を変えたら直す。
export const JOURNAL_MAX_LIMIT = 1000;

export type PageOutcome = 'progress' | 'end' | 'retryLarger' | 'blocked';

export interface PageCursor {
  id: string;
  at: string;
}

// `undefined`（古いデーモン）を `null`（終端）と同じに扱わない: 件数での推定へ倒すため。
function outcomeFromNext(next: PageCursor | null | undefined): 'end' | 'progress' | undefined {
  if (next === undefined) return undefined;
  return next === null ? 'end' : 'progress';
}

export async function readThroughUnreadable<
  P extends { entries: readonly unknown[]; next?: PageCursor | null },
>(first: P, fetchAfter: (cursor: PageCursor) => Promise<P>): Promise<P> {
  let page = first;
  while (page.entries.length === 0 && page.next !== undefined && page.next !== null) {
    page = await fetchAfter(page.next);
  }
  return page;
}

export function pageOutcome(
  pageLength: number,
  limit: number,
  freshCount: number,
  maxLimit: number = JOURNAL_MAX_LIMIT,
): PageOutcome {
  if (freshCount > 0) return 'progress';
  if (pageLength < limit) return 'end';
  return limit < maxLimit ? 'retryLarger' : 'blocked';
}

export function oldestAt(entries: JournalEntry[]): string | undefined {
  return entries.at(-1)?.at;
}

export function newestAt(entries: JournalEntry[]): string | undefined {
  return entries[0]?.at;
}

export function newerPageQuery(entries: JournalEntry[]): { since: string } | undefined {
  const since = newestAt(entries);
  return since === undefined ? undefined : { since };
}

/**
 * SSE の受信の履歴（`recent`）から、窓の先頭より古くない行だけを残す。`recent` は画面を開く前の行も持つので、
 * 窓に入らなかった古い行まで `mergeFront` へ渡すと最新の行より上に積まれる。窓より古い行は「もっと遡る」の頁で取る。
 * 先頭と同じ時刻は残す（同じミリ秒の別の行を落とさない。窓に既に在る行は `mergeFront` の id の重複除けで落ちる）。
 * 窓が空なら全部残す（初期読み込みの応答で置き換わる）。時刻が読めない行は残す（黙って消さない）。
 */
export function notOlderThanWindow(
  existing: JournalEntry[],
  incoming: JournalEntry[],
): JournalEntry[] {
  const head = newestAt(existing);
  if (head === undefined) return incoming;
  const headMs = Date.parse(head);
  if (Number.isNaN(headMs)) return incoming;
  return incoming.filter((entry) => {
    const ms = Date.parse(entry.at);
    return Number.isNaN(ms) || ms >= headMs;
  });
}

export function olderPageQuery(
  entries: JournalEntry[],
  cursor?: PageCursor | null,
): { until: string } | { afterId: string; afterAt: string } | undefined {
  // 継続点が在れば `until` を使わない: 末尾の `at` は読めずに捨てられた行を越えられず、inclusive な `until` は境界の行を再送するため。
  if (cursor !== undefined) {
    return cursor === null ? undefined : { afterId: cursor.id, afterAt: cursor.at };
  }
  const until = oldestAt(entries);
  return until === undefined ? undefined : { until };
}

export interface PageApplication {
  entries: JournalEntry[];
  outcome: PageOutcome;
  freshCount: number;
}

// `applyOlderPage` に通さない: 既存が空だと `freshCount` が常に `page.length` になり、短い日誌でも初期読み込みだけでは `'end'` にならないため。
export function applyInitialPage(
  page: JournalEntry[],
  limit: number,
  next?: PageCursor | null,
): PageApplication {
  return {
    entries: page,
    outcome: outcomeFromNext(next) ?? (page.length < limit ? 'end' : 'progress'),
    freshCount: page.length,
  };
}

export function applyOlderPage(
  existing: JournalEntry[],
  page: JournalEntry[],
  limit: number,
  maxLimit: number = JOURNAL_MAX_LIMIT,
  next?: PageCursor | null,
): PageApplication {
  const merged = mergeBack(existing, page);
  return {
    entries: merged.entries,
    outcome: outcomeFromNext(next) ?? pageOutcome(page.length, limit, merged.freshCount, maxLimit),
    freshCount: merged.freshCount,
  };
}

// core の `describeJournalHorizonNote` を共有しない: 本体から値を import するとサーバ専用の層ごとバンドルへ入るため。
// `end` 以外では出さない: 常に見える注記は、本当に終端に達したときの目印にならない。
export function journalHorizonNote(
  outcome: PageOutcome,
  oldestAt: string | null | undefined,
  crossesHorizon: boolean | undefined,
): string | undefined {
  if (outcome !== 'end') return undefined;
  if (crossesHorizon !== true) return undefined;
  if (oldestAt === null || oldestAt === undefined) return undefined;
  return (
    `この記憶ストアの日誌の最古は ${oldestAt}。それより前に本当に何も無かったのか、` +
    '記録がそこまで遡れないだけなのかは、この一覧だけからは区別できない。'
  );
}

export function journalHorizonNoteForHuman(
  outcome: PageOutcome,
  oldestAt: string | null | undefined,
  crossesHorizon: boolean | undefined,
  formatTime: (iso: string) => string,
): string | undefined {
  if (journalHorizonNote(outcome, oldestAt, crossesHorizon) === undefined) return undefined;
  return (
    `記録は ${formatTime(oldestAt as string)} より前には遡れない。それより前に本当に何も無かったのか、` +
    '記録が残っていないだけなのかは、この一覧だけからは区別できない。'
  );
}

export function applyNewerPage(
  existing: JournalEntry[],
  page: JournalEntry[],
  limit: number,
  maxLimit: number = JOURNAL_MAX_LIMIT,
): PageApplication {
  const merged = mergeFront(existing, page);
  return {
    entries: merged.entries,
    outcome: pageOutcome(page.length, limit, merged.freshCount, maxLimit),
    freshCount: merged.freshCount,
  };
}

export function filterByType(
  entries: JournalEntry[],
  selected: readonly JournalEntry['type'][],
): JournalEntry[] {
  return selected.length === 0 ? entries : entries.filter((entry) => selected.includes(entry.type));
}

// 照合は `matchesJournalSearch` を通す: 欄の一覧を画面側へ写すと、サーバ側と「当たる」の意味が静かにずれるため。
export function filterRecent(
  entries: JournalEntry[],
  selected: readonly JournalEntry['type'][],
  q: string,
): JournalEntry[] {
  const byType = filterByType(entries, selected);
  return q === '' ? byType : byType.filter((entry) => matchesJournalSearch(entry, q));
}

// 新着は自動で先頭に積む: 貯めてボタンで流す形は、押さないと最新が見えず日誌の役目が削れるため。
export function shiftForPrepend(wasPrepend: boolean, atTop: boolean, reading = false): boolean {
  return wasPrepend && (!atTop || reading);
}

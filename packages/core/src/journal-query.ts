import { matchesJournalSearch } from './journal-search.js';
import type { JournalEntry } from './schema.js';
import type { JournalQuery } from './store.js';

/**
 * 日誌の読み出しから外す行の集合（fs と インメモリが持つ）: 墓標（`conversation_deleted`）が消した会話の id と、墓標が名指しした行（`hiddenEntryIds`）の id。
 * pg は同じ意味を SQL（`hiddenConversationExchangeExcluded`）で書く。条件を変えるときは両方を直す。
 */
export interface JournalTombstones {
  conversations: Set<string>;
  entries: Set<string>;
}

export function emptyJournalTombstones(): JournalTombstones {
  return { conversations: new Set(), entries: new Set() };
}

export function addJournalTombstone(
  tombstones: JournalTombstones,
  entry: Extract<JournalEntry, { type: 'conversation_deleted' }>,
): void {
  tombstones.conversations.add(entry.deletedConversationId);
  for (const id of entry.hiddenEntryIds ?? []) tombstones.entries.add(id);
}

/** 積んだ行から墓標の集合を導く: 集合を別に持つと `clear()` と食い違うため（インメモリ用）。 */
export function journalTombstonesOf(entries: Iterable<JournalEntry>): JournalTombstones {
  const tombstones = emptyJournalTombstones();
  for (const entry of entries) {
    if (entry.type === 'conversation_deleted') addJournalTombstone(tombstones, entry);
  }
  return tombstones;
}

/** 読み出しから外す行か: 墓標が名指しした行、または墓標のある会話の `exchange`（`list` / `get` / `oldestAt` が同じ答えを出す）。 */
export function isHiddenJournalEntry(entry: JournalEntry, tombstones: JournalTombstones): boolean {
  if (tombstones.entries.has(entry.id)) return true;
  return (
    entry.type === 'exchange' &&
    entry.conversationId !== undefined &&
    tombstones.conversations.has(entry.conversationId)
  );
}

/**
 * `list` の行ごとの絞り込み（`types` / `with` / `conversationId` / `q` / `since` / `until` の AND）。
 * 隠す行（`isHiddenJournalEntry`）・`after`・`order`・`limit` は含まない: 隠す行は `limit` を数える前に外す順に意味があり、残りは器の走査の仕事。
 * `since` / `until` は真偽で見る（空文字は絞らない）: fs が元々そう書いていて、本番の動きを変えないため。
 */
export function matchesJournalQuery(
  entry: JournalEntry,
  query: Pick<JournalQuery, 'types' | 'with' | 'conversationId' | 'q' | 'since' | 'until'>,
): boolean {
  if (query.types && !query.types.includes(entry.type)) return false;
  if (query.with && (entry.type !== 'exchange' || !query.with.includes(entry.with))) return false;
  if (
    query.conversationId !== undefined &&
    !('conversationId' in entry && entry.conversationId === query.conversationId)
  ) {
    return false;
  }
  // 欄の選び方をここへ書き写さない: 照合は `journal-search.ts` が持ち、3実装が同じ答えを出すため
  if (query.q !== undefined && !matchesJournalSearch(entry, query.q)) return false;
  if (query.since && entry.at < query.since) return false;
  if (query.until && entry.at > query.until) return false;
  return true;
}

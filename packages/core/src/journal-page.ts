import type { JournalPage, JournalQuery, JournalStore } from './store.js';

// `list()` が `LIMIT` の後で捨てる実装（pg）には使わない: 余り1件の推し方が正確でなくなるため
export async function listPageByOverfetch(
  journal: Pick<JournalStore, 'list'>,
  query: JournalQuery = {},
): Promise<JournalPage> {
  const { limit } = query;
  if (limit === undefined || limit <= 0) {
    return { entries: await journal.list(query), next: null };
  }
  const found = await journal.list({ ...query, limit: limit + 1 });
  if (found.length <= limit) return { entries: found, next: null };
  const entries = found.slice(0, limit);
  const last = entries[entries.length - 1];
  if (last === undefined) return { entries, next: null };
  return { entries, next: { id: last.id, at: last.at } };
}

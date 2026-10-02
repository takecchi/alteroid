import type { JournalPage, JournalQuery, JournalStore } from './store.js';

/**
 * `list()` が「読めない行を捨てない」実装（fs・インメモリ）で `listPage()` を
 * 作る（Issue #2604 / #2605）。
 *
 * `limit + 1` 件を取り、1件余れば続きが在る。余りは返さず、返す最後の行を
 * 継続点にする。捨てた行が頁に混ざらない（fs は `limit` を数える前に捨てる）
 * ので、この推し方が正確である。**`list()` が `LIMIT` の後で捨てる実装（pg）
 * には使えない**——そちらは自前で `listPage()` を持つ。
 *
 * `limit` が未指定・`0` 以下のときは続きを言わない（全件／0件を求めた呼びに
 * 「続き」は無い）。
 */
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
  // `limit >= 1` なので `entries` は空にならない。型のための確認で、踏むことは無い。
  if (last === undefined) return { entries, next: null };
  return { entries, next: { id: last.id, at: last.at } };
}

/**
 * resume で戻す記録（作業者の分・peer の分）を、合計の上限に収まるぶんだけ選ぶ。
 * 呼び手ごとに違うのは、落としたものを名指す鍵の欄（`subpath` / `peerId`）と上限の値だけである。
 */

function charsOf(entries: readonly unknown[]): number {
  let total = 0;
  for (const entry of entries) total += (JSON.stringify(entry) ?? '').length;
  return total;
}

// 最後の entry の `timestamp` を新しさとする。読めなければ最も古い扱い（落とす側へ倒す）
function recencyOf(entries: readonly unknown[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== 'object' || entry === null) continue;
    const stamp = (entry as { timestamp?: unknown }).timestamp;
    if (typeof stamp === 'string') {
      const parsed = Date.parse(stamp);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return Number.NEGATIVE_INFINITY;
}

/**
 * 新しい順に、合計（各 entry の JSON の文字数の和）が上限に収まるぶんだけ選ぶ。新しさが同じなら鍵の大きいほうを先にする。
 * 1本が入らなくても、次の（より小さい）ものが入るなら入れる。
 * 落としたものの鍵は `omitted` に返す（呼び出し側が日誌へ残す。黙って落とさない）。
 */
export function selectNewestWithinBudget<T extends { readonly entries: readonly unknown[] }>(
  candidates: readonly T[],
  keyOf: (candidate: T) => string,
  budgetChars: number,
): { included: T[]; omitted: string[] } {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      key: keyOf(candidate),
      recency: recencyOf(candidate.entries),
    }))
    .sort((a, b) => b.recency - a.recency || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const included: T[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const { candidate, key } of ranked) {
    const size = charsOf(candidate.entries);
    if (used + size > budgetChars) {
      omitted.push(key);
      continue;
    }
    used += size;
    included.push(candidate);
  }
  return { included, omitted };
}

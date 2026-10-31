/**
 * 墓標を上書きせずに複数持つための、3つの器（fs / pg / メモリ）で共通の純粋な計算（#4884）。
 *
 * 墓標は上書きせず、古い順の1本の列で持つ:
 * 墓標が残っているところへ別の墓標が立つと、上書きすると前の区間が二度と記憶へ移らない。
 * 蒸留が利用枠で落ちる時期は墓標が続けて立つ時期そのものなので、上書きは現実に起こる。
 * 墓標を1つだけ置く別の口は持たない（本番の経路が使わないので外した。#5869）。
 */

/** 列の上限。超えたら古い方（先頭）から落とし、呼び出し側が日誌に残す。 */
export const MAX_PENDING_GRAVES = 20;

/**
 * `grave` を足す。同じ墓標が既に在れば何もせず、それ以外は末尾へ。
 * 上限を超えた分は古い方から落として `dropped` で返す（捨てたことを黙らせない）。
 */
export function addGrave<T>(
  queue: readonly T[],
  grave: T,
  same: (a: T, b: T) => boolean,
  cap: number = MAX_PENDING_GRAVES,
): { queue: T[]; dropped: T[] } {
  if (queue.some((queued) => same(queued, grave))) return { queue: [...queue], dropped: [] };
  const all = [...queue, grave];
  const overflow = Math.max(0, all.length - cap);
  return { queue: all.slice(overflow), dropped: all.slice(0, overflow) };
}

/** `match` に当たるものを下ろす。下ろしたら `removed: true`。 */
export function removeGrave<T>(
  queue: readonly T[],
  match: (grave: T) => boolean,
): { queue: T[]; removed: boolean } {
  const kept = queue.filter((queued) => !match(queued));
  return { queue: kept, removed: kept.length !== queue.length };
}

/**
 * 墓標ごとの「蒸留が続けて失敗した回数」（#4898）。graveId → 回数。3つの器で同じ形で持つ。
 * 保存値は `{ counts: { [graveId]: n } }`。
 */
export type DistillFailureCounts = Record<string, number>;

export function parseDistillFailureCounts(value: unknown): DistillFailureCounts | null {
  if (typeof value !== 'object' || value === null) return null;
  const { counts } = value as { counts?: unknown };
  const isCount = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0;
  if (typeof counts === 'object' && counts !== null && !Array.isArray(counts)) {
    const result: DistillFailureCounts = Object.create(null) as DistillFailureCounts;
    for (const [id, n] of Object.entries(counts)) {
      if (id.length === 0 || !isCount(n)) return null;
      result[id] = n;
    }
    return result;
  }
  return null;
}

export function serializeDistillFailureCounts(counts: DistillFailureCounts): string {
  return JSON.stringify({ counts });
}

/** `ids` の回数を忘れた写しを返す。 */
export function forgetDistillFailureCounts(
  counts: DistillFailureCounts,
  ids: readonly string[],
): DistillFailureCounts {
  const result: DistillFailureCounts = Object.create(null) as DistillFailureCounts;
  for (const [id, n] of Object.entries(counts)) {
    if (!ids.includes(id)) result[id] = n;
  }
  return result;
}

/** 回数を読む（無ければ 0）。 */
export function readDistillFailureCount(counts: DistillFailureCounts | null, id: string): number {
  return counts !== null && Object.hasOwn(counts, id) ? (counts[id] ?? 0) : 0;
}

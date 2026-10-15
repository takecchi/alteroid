/**
 * 墓標を上書きせずに複数持つための、3つの器（fs / pg / メモリ）で共通の純粋な計算（#4884）。
 *
 * 墓標の1枠（`SessionRegistry.getTranscriptGrave` など）は残したまま、その後ろに順番待ちの列を持つ:
 * 枠が埋まっているところへ別の墓標が立つと、上書きすると前の区間が二度と記憶へ移らない。
 * 蒸留が枠で落ちる時期は墓標が続けて立つ時期そのものなので、上書きは現実に起こる。
 */

/** 枠と列を合わせた上限。超えたら古い方（枠が先頭、次に列の先頭）から落とし、呼び出し側が日誌に残す。 */
export const MAX_PENDING_GRAVES = 20;

export interface GraveQueueState<T> {
  primary: T | null;
  queue: T[];
}

/**
 * `grave` を足す。枠が空なら枠へ、同じ墓標が既に在れば何もせず、それ以外は列の末尾へ。
 * 上限を超えた分は古い方から落として `dropped` で返す（捨てたことを黙らせない）。
 */
export function addGrave<T>(
  state: GraveQueueState<T>,
  grave: T,
  same: (a: T, b: T) => boolean,
  cap: number = MAX_PENDING_GRAVES,
): GraveQueueState<T> & { dropped: T[] } {
  // 枠が空で列だけ残っている（古い版が書いた形）なら、足す前に先頭を枠へ昇格させる: 昇格させずに足すと、いちばん新しいものが枠（先頭）になり、上限で落とすのが最古でなくなる（#4898）
  const base = promoteHead(state);
  if (base.primary !== null && same(base.primary, grave)) return { ...base, dropped: [] };
  if (base.queue.some((queued) => same(queued, grave))) return { ...base, dropped: [] };
  if (base.primary === null) return { primary: grave, queue: [], dropped: [] };

  const all = [base.primary, ...base.queue, grave];
  const overflow = Math.max(0, all.length - cap);
  const dropped = all.slice(0, overflow);
  const kept = all.slice(overflow);
  const [primary, ...queue] = kept;
  return { primary: primary ?? null, queue, dropped };
}

/** 枠が空で列に残りがあるときだけ、列の先頭を枠へ上げる。 */
function promoteHead<T>(state: GraveQueueState<T>): GraveQueueState<T> {
  if (state.primary !== null || state.queue.length === 0) return state;
  const [head, ...rest] = state.queue;
  return { primary: head ?? null, queue: rest };
}

/** 枠 → 列の順（古い順）。 */
export function listGraves<T>(state: GraveQueueState<T>): T[] {
  return state.primary === null ? [...state.queue] : [state.primary, ...state.queue];
}

/** 枠か列から `match` に当たるものを下ろす。下ろしたら `removed: true`。 */
export function removeGrave<T>(
  state: GraveQueueState<T>,
  match: (grave: T) => boolean,
): GraveQueueState<T> & { removed: boolean } {
  const primaryHit = state.primary !== null && match(state.primary);
  const queue = state.queue.filter((queued) => !match(queued));
  const removed = primaryHit || queue.length !== state.queue.length;
  return { ...promoteHead({ primary: primaryHit ? null : state.primary, queue }), removed };
}

/**
 * 墓標ごとの「蒸留が続けて失敗した回数」（#4898）。graveId → 回数。3つの器で同じ形で持つ。
 * 保存値は `{ counts: { [graveId]: n } }`。古い形（`{ graveId, failures }` の1件）も読める。
 */
export type DistillFailureCounts = Record<string, number>;

export function parseDistillFailureCounts(value: unknown): DistillFailureCounts | null {
  if (typeof value !== 'object' || value === null) return null;
  const { counts, graveId, failures } = value as {
    counts?: unknown;
    graveId?: unknown;
    failures?: unknown;
  };
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
  // 古い形: 種類ごとに1件だけ
  if (typeof graveId === 'string' && graveId.length > 0 && isCount(failures)) {
    const result: DistillFailureCounts = Object.create(null) as DistillFailureCounts;
    result[graveId] = failures;
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

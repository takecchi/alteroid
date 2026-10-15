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
  if (state.primary !== null && same(state.primary, grave)) return { ...state, dropped: [] };
  if (state.queue.some((queued) => same(queued, grave))) return { ...state, dropped: [] };
  if (state.primary === null) return { primary: grave, queue: [...state.queue], dropped: [] };

  const all = [state.primary, ...state.queue, grave];
  const overflow = Math.max(0, all.length - cap);
  const dropped = all.slice(0, overflow);
  const kept = all.slice(overflow);
  const [primary, ...queue] = kept;
  return { primary: primary ?? null, queue, dropped };
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
  if (state.primary !== null && match(state.primary)) {
    return { primary: null, queue: [...state.queue], removed: true };
  }
  const queue = state.queue.filter((queued) => !match(queued));
  return { primary: state.primary, queue, removed: queue.length !== state.queue.length };
}

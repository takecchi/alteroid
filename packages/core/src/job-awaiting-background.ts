import type { Job } from './schema.js';

/**
 * 背景処理の完了待ちで閉じた `done` を「task を倒さない保留」として読む上限。
 * 上限が無いと、印（`Job.awaitingBackgroundSince`）を下ろす報告が二度と来ない経路（runner が落ちた・器が消えた・`closed` を出す前に途切れた）で、
 * task が `waiting` のまま永久に居座り、`needs_decision` による発意 tick の安全網を失う。
 * 印は背景待ちの報告のたびに進める（便りが来続ける委譲は生きている）ので、この長さは「runner からの便りが途絶えてから」である。
 * 6 時間は背景処理（ビルド・長いテスト・peer の相談）が静かに続く現実的な長さの上で、半日の放置にはならない幅として置いた。
 */
export const AWAITING_BACKGROUND_HOLD_LIMIT_MS = 6 * 60 * 60 * 1000;

/**
 * `done` の委譲が「背景処理の完了待ちで閉じたターンの後で、まだ生きている」と読めるか。
 * 読めるなら、結び付いた task は倒さない（`waiting` のまま）。印が読めない・上限を過ぎたときは偽（今までどおり終わった委譲として扱う）。
 * 時計は呼び手が渡す（`ManagerPool` は `#now()`）: 試験が `advance` できるように、ここでは `Date.now()` を読まない。
 */
export function isAwaitingBackgroundHold(
  job: Pick<Job, 'status' | 'awaitingBackgroundSince'>,
  nowMs: number,
): boolean {
  if (job.status !== 'done' || job.awaitingBackgroundSince === undefined) return false;
  const since = Date.parse(job.awaitingBackgroundSince);
  if (Number.isNaN(since)) return false;
  return nowMs - since < AWAITING_BACKGROUND_HOLD_LIMIT_MS;
}

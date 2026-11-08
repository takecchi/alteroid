import type { Job } from './schema.js';

/**
 * 報告由来の `done`（ターンの終わり）で結び付いた task を `needs_decision` へ倒すまでの猶予。
 * runner はターンが 1 回終わるたびに idle・背景待ち・完了を区別しない `done` を出し、台帳にも「担当が完了と報告した」を表す欄が無い。
 * 即時に倒すと、`manager_send` で次の指示を送る会話型の委譲が、ターンごとに `waiting` と `needs_decision` を往復する。
 * クローンが 1 往復で次の `manager_send` を打つ間に収まり、かつ半日の放置にならない幅として 30 分に置いた。
 * 猶予を過ぎて静かなままなら見回り（`ManagerPool.repairStrandedTasks`）が倒すので、最悪でも「30 分遅れて今までと同じ」になる。
 * 猶予が 0 なのは `stopped`・`failed`・`lost`・`closed(done)`（セッションが畳まれた）で、これらは `#syncTask` が即時に倒す。
 */
export const TASK_FOLLOW_GRACE_MS = 30 * 60 * 1000;

/**
 * `done` の委譲が、終端へ入ってから猶予の内か。内なら結び付いた task は倒さない（`waiting` のまま）。
 * `endedAt` が無い・読めない行は偽（今までどおり終わった委譲として扱う）。
 * 時計は呼び手が渡す: 試験が `advance` できるように、ここでは `Date.now()` を読まない。
 */
export function isWithinTaskFollowGrace(
  job: Pick<Job, 'status' | 'endedAt'>,
  nowMs: number,
): boolean {
  if (job.status !== 'done' || job.endedAt === undefined) return false;
  const endedAt = Date.parse(job.endedAt);
  if (Number.isNaN(endedAt)) return false;
  return nowMs - endedAt < TASK_FOLLOW_GRACE_MS;
}

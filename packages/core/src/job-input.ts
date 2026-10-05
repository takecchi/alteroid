import { assertNoNul, stripNulDeep } from './nul-guard.js';
import type { Job, PendingApproval } from './schema.js';

/**
 * ジョブの書き込みの入口の NUL の扱い（issue #3011。teto の判断、2026-10-06）。3実装（インメモリ / fs / pg）が呼ぶ。
 *
 * - `id`（鍵）に NUL があれば `NulNotAllowedError` で断る
 * - それ以外の文字列は、本文（`summary`・`request`・`lastReport`）も参照キー・印（`conversationId`・`managerId`・
 *   `sessionId`・`projectKey`・`runnerId` など）も、落として残す。参照キーは自分の行を指す鍵ではなく、
 *   よそへの参照や印で、断るとジョブの記録が丸ごと落ちる（commitments の `source` と同じ。`nul-guard.ts`）
 *
 * 形が不正な入力はここで落とさず、後ろのスキーマの検証に任せる。
 */
export function prepareJobForWrite(job: Job): Job {
  if (typeof job.id === 'string') assertNoNul('job.id', job.id);
  return stripNulDeep(job);
}

/**
 * 承認待ちの書き込みの入口。`id` は断る。それ以外の文字列は、本文（`question`・`context`・`answer`）も、
 * 参照（`jobId`・`requestId`）も、`questions` / `selections` の中（選択肢の文言・`other`・`questionId` など）も、落として残す。
 */
export function prepareApprovalForWrite(approval: PendingApproval): PendingApproval {
  if (typeof approval.id === 'string') assertNoNul('approval.id', approval.id);
  return stripNulDeep(approval);
}

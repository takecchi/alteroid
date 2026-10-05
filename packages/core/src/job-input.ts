import { assertNoNul, stripNul } from './nul-guard.js';
import type { Job, PendingApproval } from './schema.js';

/**
 * ジョブの書き込みの入口の NUL の扱い（issue #3011。teto の判断、2026-10-06）。3実装（インメモリ / fs / pg）が呼ぶ。
 *
 * - `id`（鍵）に NUL があれば `NulNotAllowedError` で断る
 * - 本文（`summary`・`request`・`lastReport`）の NUL は落として残す
 * - 参照キー（`conversationId`・`managerId` など）の NUL の扱いは未決なので、ここでは触らない
 */
export function prepareJobForWrite(job: Job): Job {
  if (typeof job.id === 'string') assertNoNul('job.id', job.id);
  return {
    ...job,
    ...(typeof job.summary === 'string' ? { summary: stripNul(job.summary) } : {}),
    ...(typeof job.request === 'string' ? { request: stripNul(job.request) } : {}),
    ...(typeof job.lastReport === 'string' ? { lastReport: stripNul(job.lastReport) } : {}),
  };
}

/** 承認待ちの書き込みの入口。`id` は断り、本文（`question`・`context`・`answer`）は落として残す。参照は触らない。 */
export function prepareApprovalForWrite(approval: PendingApproval): PendingApproval {
  if (typeof approval.id === 'string') assertNoNul('approval.id', approval.id);
  return {
    ...approval,
    ...(typeof approval.question === 'string' ? { question: stripNul(approval.question) } : {}),
    ...(typeof approval.context === 'string' ? { context: stripNul(approval.context) } : {}),
    ...(typeof approval.answer === 'string' ? { answer: stripNul(approval.answer) } : {}),
  };
}

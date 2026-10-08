import { assertNoNul, stripNulDeep } from './nul-guard.js';
import type { Job, PendingApproval } from './schema.js';

// `id` 以外の NUL は断らず落として残す: 参照キーは自分の行を指す鍵ではなく、断るとジョブの記録が丸ごと落ちるため
export function prepareJobForWrite(job: Job): Job {
  if (typeof job.id === 'string') assertNoNul('job.id', job.id);
  return stripNulDeep(job);
}

export function prepareApprovalForWrite(approval: PendingApproval): PendingApproval {
  if (typeof approval.id === 'string') assertNoNul('approval.id', approval.id);
  return stripNulDeep(approval);
}

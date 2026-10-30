import type { JobStatus } from './schema.js';

// `waiting_human` を「実行中」に含めない: 止まっているだけの委譲まで「動いている」と数えて、字面と件数が食い違うため
// 未知の値は実行中として数える: 数えないと、新しい値が件数から静かに漏れるため
export function isRunningJobStatus(status: JobStatus): boolean {
  switch (status) {
    case 'running':
      return true;
    case 'waiting_human':
    case 'done':
    case 'failed':
    case 'lost':
    case 'stopped':
      return false;
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return true;
    }
  }
}

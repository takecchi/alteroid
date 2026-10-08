// `schema.ts` を import せず型を手で複製する: zod ごとブラウザバンドルへ入るため
// `waiting_human` を「実行中」に含めない: 止まっているだけの委譲まで「動いている」と数えて、字面と件数が食い違うため
export type JobStatusLike = 'running' | 'waiting_human' | 'done' | 'failed' | 'lost' | 'stopped';

const JOB_STATUS_LIKE_NAMES = {
  running: true,
  waiting_human: true,
  done: true,
  failed: true,
  lost: true,
  stopped: true,
} satisfies Record<JobStatusLike, true>;

export const JOB_STATUS_LIKE_VALUES = Object.keys(JOB_STATUS_LIKE_NAMES) as JobStatusLike[];

// 未知の値は実行中として数える: 数えないと、新しい値が件数から静かに漏れるため
export function isRunningJobStatus(status: JobStatusLike): boolean {
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

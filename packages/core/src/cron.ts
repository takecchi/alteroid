import { Cron } from 'croner';

export const CRON_EXPRESSION_MAX = 120;

const CRON_FIELD_COUNT = 5;

export interface CronSchedule {
  nextAfter(after: Date): Date | null;
}

export function parseCron(expression: string): CronSchedule | null {
  const trimmed = expression.trim();
  if (trimmed.length === 0 || trimmed.length > CRON_EXPRESSION_MAX) return null;

  // 5欄以外を croner に渡さない: 6欄を通すと秒の周期で起こす仕込みが入口をすり抜けるため
  if (trimmed.split(/\s+/).length !== CRON_FIELD_COUNT) return null;

  let job: Cron;
  try {
    // `paused` にする: しないとこの場でタイマーが動き出すため
    job = new Cron(trimmed, { paused: true });
  } catch {
    return null;
  }

  // 二度と来ない式は読めない扱いにする: 仕込めると、時刻が来れば必ず届くという約束が静かに破れるため
  if (job.nextRun(new Date()) === null) return null;

  return {
    nextAfter(after) {
      return job.nextRun(after);
    },
  };
}

export function isCronExpression(expression: string): boolean {
  return parseCron(expression) !== null;
}

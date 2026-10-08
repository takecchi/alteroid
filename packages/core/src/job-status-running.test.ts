import { describe, expect, it } from 'vitest';

import {
  isRunningJobStatus,
  JOB_STATUS_LIKE_VALUES,
  type JobStatusLike,
} from './job-status-running.js';
import { jobStatusSchema } from './schema.js';

describe('isRunningJobStatus（9回目の横断レビュー指摘の唯一の正本）', () => {
  it('running だけを実行中として数える', () => {
    expect(isRunningJobStatus('running')).toBe(true);
  });

  it.each(jobStatusSchema.options.filter((status) => status !== 'running'))(
    '%s は実行中として数えない',
    (status) => {
      expect(isRunningJobStatus(status)).toBe(false);
    },
  );

  it('jobStatusSchema の全選択肢がちょうど1つの分類に入る（running 1 + 非 running 5）', () => {
    const running = jobStatusSchema.options.filter((s) => isRunningJobStatus(s));
    const notRunning = jobStatusSchema.options.filter((s) => !isRunningJobStatus(s));
    expect(running).toEqual(['running']);
    expect(notRunning).toEqual(['waiting_human', 'done', 'failed', 'lost', 'stopped']);
    expect(running.length + notRunning.length).toBe(jobStatusSchema.options.length);
  });

  it('知らない値は安全側（実行中として数える）へ倒れる', () => {
    const unknownStatus = 'not-yet-invented-status' as unknown as JobStatusLike;
    expect(isRunningJobStatus(unknownStatus)).toBe(true);
  });

  it('JOB_STATUS_LIKE_VALUES は jobStatusSchema.options と同じ集合を持つ', () => {
    expect(new Set(JOB_STATUS_LIKE_VALUES)).toEqual(new Set(jobStatusSchema.options));
  });
});

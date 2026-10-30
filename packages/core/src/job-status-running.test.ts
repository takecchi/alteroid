import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isRunningJobStatus } from './job-status-running.js';
import { jobStatusSchema, type JobStatus } from './schema.js';

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
    const unknownStatus = 'not-yet-invented-status' as unknown as JobStatus;
    expect(isRunningJobStatus(unknownStatus)).toBe(true);
  });
});

describe('job-status-running は軽い出口として出さない（#5814）', () => {
  // 呼び手が core の中（progress.ts・tools.ts）だけで、subpath から読む者がいないため
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));

  it('package.json の exports に subpath が無い', () => {
    const pkg = JSON.parse(readFileSync(`${packageRoot}package.json`, 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports)).not.toContain('./job-status-running');
  });

  it('tsup の entry に載っていない', () => {
    expect(readFileSync(`${packageRoot}tsup.config.ts`, 'utf8')).not.toContain(
      'src/job-status-running.ts',
    );
  });
});

import { describe, expect, it } from 'vitest';

import { runChildAgainstSrc, siblingSrcPath } from './child-src.test-support.js';
import { noteUncaught } from './dropped-record.js';
import { captureStderr } from './testing.js';
import { installUncaughtNet } from './uncaught-net.js';

describe('未捕捉の例外の網（#438）', () => {
  const secret = 'ghp_000000000000000000000000000000000000';

  it('出所（origin）ごとに違う文言で、接頭辞つきの1行だけ残す', async () => {
    const lines = await captureStderr(() => {
      noteUncaught('alteroidd', 'uncaughtException', new Error('boom'));
      noteUncaught('alteroidd', 'unhandledRejection', new Error('boom'));
    });

    {
      expect(lines).toHaveLength(2);
      const [thrown, rejected] = lines as [string, string];

      expect(thrown.startsWith('alteroidd: ')).toBe(true);
      expect(rejected.startsWith('alteroidd: ')).toBe(true);

      expect(thrown).toContain('未捕捉の例外を観測しました');
      expect(rejected).toContain('未処理の Promise 拒否を観測しました');
      expect(thrown).not.toContain('未処理の Promise 拒否');
      expect(rejected).not.toContain('未捕捉の例外');

      for (const line of lines) {
        expect(line.endsWith('\n')).toBe(true);
      }

      for (const line of lines) {
        expect(line).not.toContain('落ち');
      }
    }
  });

  it('理由は1行目だけ・200字で切る（2行目に添えられた値は跡へ出さない）', async () => {
    const lines = await captureStderr(() => {
      noteUncaught(
        'alteroidd',
        'uncaughtException',
        new Error(`Failed query: select 1\nparams: ${secret}`),
      );
      noteUncaught('alteroidd', 'uncaughtException', new Error('x'.repeat(500)));
    });

    {
      const [twoLine, long] = lines as [string, string];
      expect(twoLine).toContain('Failed query: select 1');
      expect(twoLine).not.toContain(secret);
      expect(twoLine.trimEnd()).not.toContain('\n');
      expect(long).toContain('…');
      expect(long.length).toBeLessThan(400);
    }
  });

  it('外す関数を呼べば listener が残らない', () => {
    const before = process.listenerCount('uncaughtExceptionMonitor');
    const uninstall = installUncaughtNet('alteroidd');
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before + 1);
    uninstall();
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before);
  });

  it('網を張っても、未捕捉の例外では今日どおりプロセスが死ぬ（既定のスタックごと）', async () => {
    const entry = siblingSrcPath(import.meta.url, 'uncaught-net.ts');
    const failure = await runChildAgainstSrc([
      `import { installUncaughtNet } from ${JSON.stringify(entry)};`,
      `installUncaughtNet('alteroidd');`,
      `setImmediate(() => { throw new Error('boom-from-child'); });`,
    ]);

    expect(failure).not.toBeNull();
    expect(failure?.code).toBe(1);

    const stderr = failure?.stderr ?? '';
    expect(stderr).toContain('Error: boom-from-child');
    expect(stderr).toMatch(/\n\s+at /u);
    expect(stderr).toContain('alteroidd: ');
    expect(stderr).toContain('未捕捉の例外を観測しました');
  });
});

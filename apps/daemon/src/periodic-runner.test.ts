import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setStderrSinkForTesting } from '@alteroid/core';

import { startPeriodicRun } from './periodic-runner.js';

// 重ねない周期の繰り返しの骨組みを1つにする（#5697。manager-poller・attachment-prune・archive-folder が使う）
describe('startPeriodicRun', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('起動時にすぐ1回走らせ、終わってから一定間隔で次を走らせる', async () => {
    let runs = 0;
    const periodic = startPeriodicRun({
      intervalMs: 1_000,
      run: async () => {
        runs += 1;
        return runs;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(2);
    periodic.stop();
  });

  it('走っている間の refresh は同じ回を返し、重ねて走らせない', async () => {
    let release!: () => void;
    let runs = 0;
    const periodic = startPeriodicRun({
      intervalMs: 1_000,
      run: () => {
        runs += 1;
        return new Promise<number>((resolve) => {
          release = () => resolve(runs);
        });
      },
    });
    const a = periodic.refresh();
    const b = periodic.refresh();
    expect(a).toBe(b);
    expect(runs).toBe(1);
    release();
    await expect(a).resolves.toBe(1);
    periodic.stop();
  });

  it('次の間隔は、前の回が終わってから数える（走っている時間を含めない）', async () => {
    let release!: () => void;
    let runs = 0;
    const periodic = startPeriodicRun({
      intervalMs: 1_000,
      run: () => {
        runs += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(999);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(2);
    periodic.stop();
  });

  it('stop の後は次を予約しない。signal の abort でも止まる', async () => {
    let runs = 0;
    const stopped = startPeriodicRun({
      intervalMs: 1_000,
      run: async () => {
        runs += 1;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    stopped.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs).toBe(1);

    let abortedRuns = 0;
    const controller = new AbortController();
    startPeriodicRun({
      intervalMs: 1_000,
      signal: controller.signal,
      run: async () => {
        abortedRuns += 1;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(abortedRuns).toBe(1);
  });

  describe('run が投げたとき（#5961）', () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    let lines: string[];

    beforeEach(() => {
      unhandled.length = 0;
      process.on('unhandledRejection', onUnhandled);
      lines = [];
      setStderrSinkForTesting((line) => {
        lines.push(line);
      });
    });
    afterEach(() => {
      process.off('unhandledRejection', onUnhandled);
      setStderrSinkForTesting(null);
    });

    it('受けられない拒否にならず、stderr に1行残し、次の回を予約して走らせる', async () => {
      let runs = 0;
      const periodic = startPeriodicRun({
        intervalMs: 1_000,
        run: async () => {
          runs += 1;
          if (runs <= 2) throw new Error(`boom${runs}`);
          return runs;
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toBe(1);
      expect(lines).toEqual([
        'alteroidd: 定期処理の回が失敗しました（次の回は予約します）: Error: boom1\n',
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runs).toBe(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runs).toBe(3);
      expect(lines).toHaveLength(2);
      // 未処理の拒否はイベントループを1周してから出るので、実の setImmediate で流してから見る
      periodic.stop();
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    });

    it('refresh を直接呼んだ呼び手には、拒否のまま返す', async () => {
      let runs = 0;
      const periodic = startPeriodicRun({
        intervalMs: 1_000,
        run: async () => {
          runs += 1;
          if (runs === 2) throw new Error('direct');
          return runs;
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(periodic.refresh()).rejects.toThrow('direct');
      periodic.stop();
    });

    it('投げた回のあとでも、stop の後は予約しない', async () => {
      let runs = 0;
      const periodic = startPeriodicRun({
        intervalMs: 1_000,
        run: async () => {
          runs += 1;
          throw new Error('boom');
        },
      });
      periodic.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runs).toBe(1);
    });
  });
});

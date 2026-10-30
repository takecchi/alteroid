import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { describeLoopStall, notePhase, startLoopStallWatch, type LoopStall } from './loop-stall.js';

// 偽の時計で「止まった」を作る: 実時間でループを塞ぐと、器が混んだときに揺れ、実時間の待ちを試験に足すことにもなるため
let now = 0;
let stop: (() => void) | undefined;
let stalls: LoopStall[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  stalls = [];
  stop = startLoopStallWatch({
    intervalMs: 500,
    thresholdMs: 1_000,
    now: () => now,
    onStall: (stall) => stalls.push(stall),
  });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

/** 見張りの1周ぶん時計を進める（遅れが無い周）。 */
async function tick(): Promise<void> {
  now += 500;
  await vi.advanceTimersByTimeAsync(500);
}

/** ループが `ms` だけ塞がった後の1周: 時計だけが余分に進み、見張りは1回遅れて回る。 */
async function stalledTick(ms: number, during: () => void = () => undefined): Promise<void> {
  during();
  now += 500 + ms;
  await vi.advanceTimersByTimeAsync(500);
  // GC の観測を待つ分
  await vi.advanceTimersByTimeAsync(50);
}

describe('loop-stall（#4485）', () => {
  it('止まった長さ・直前の印・窓の中の印（経過 ms 付き）・ヒープを返す', async () => {
    await tick();
    notePhase('test:before');
    await stalledTick(4_000, () => {
      now += 1_500;
      notePhase('test:inside-a');
      now += 2_000;
      notePhase('test:inside-b');
      now -= 3_500;
    });

    expect(stalls).toHaveLength(1);
    const stall = stalls[0] as LoopStall;
    expect(stall.stalledMs).toBe(4_000);
    expect(stall.phaseBefore).toBe('test:before');
    expect(stall.phasesDuring).toEqual([
      { label: 'test:inside-a', offsetMs: 1_500 },
      { label: 'test:inside-b', offsetMs: 3_500 },
    ]);
    expect(stall.heapUsedMb).toBeGreaterThan(0);
  });

  it('文言に、止まった長さ・直前の印・窓の中の印が無いこと・GC・ヒープが載る', async () => {
    notePhase('test:culprit');
    await tick();
    await stalledTick(2_000);

    const text = describeLoopStall(stalls[0] as LoopStall);
    expect(text).toContain('2000ms 止まった');
    expect(text).toContain('直前の印: test:culprit');
    expect(text).toContain('窓の中で通った印は無い');
    expect(text).toMatch(/窓の中の GC: \d+ 回・合計 \d+ms・最大 \d+ms/);
    expect(text).toMatch(/ヒープ \d+\/\d+MB・RSS \d+MB/);
  });

  it('閾値に満たない遅れでは知らせない', async () => {
    await tick();
    await stalledTick(900);
    await tick();
    expect(stalls).toEqual([]);
  });
});

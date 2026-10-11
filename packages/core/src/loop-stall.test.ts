import { afterEach, describe, expect, it } from 'vitest';

import { describeLoopStall, notePhase, startLoopStallWatch, type LoopStall } from './loop-stall.js';

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
});

function busy(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // ループを同期で塞ぐ
  }
}

async function watchOnce(block: () => void): Promise<LoopStall> {
  const stalls: LoopStall[] = [];
  stop = startLoopStallWatch({ intervalMs: 20, thresholdMs: 200, onStall: (s) => stalls.push(s) });
  // 見張りが1周回ってから塞ぐ: 塞ぎ始めより前の印を「直前の印」として拾えるように
  await new Promise((resolve) => setTimeout(resolve, 60));
  block();
  await expect.poll(() => stalls.length, { timeout: 2000 }).toBeGreaterThan(0);
  return stalls[0] as LoopStall;
}

describe('loop-stall（#4485）', () => {
  it('同期で塞いだ長さと、塞いでいる最中に通った印を返す', async () => {
    notePhase('test:before');
    const stall = await watchOnce(() => {
      busy(150);
      notePhase('test:inside-a');
      busy(250);
      notePhase('test:inside-b');
    });

    expect(stall.stalledMs).toBeGreaterThanOrEqual(300);
    expect(stall.phaseBefore).toBe('test:before');
    expect(stall.phasesDuring.map((mark) => mark.label)).toEqual([
      'test:inside-a',
      'test:inside-b',
    ]);
    const [a, b] = stall.phasesDuring;
    expect(a?.offsetMs).toBeGreaterThanOrEqual(100);
    expect(b?.offsetMs).toBeGreaterThan(a?.offsetMs ?? 0);
    expect(stall.heapUsedMb).toBeGreaterThan(0);
  });

  it('文言に、止まった長さ・直前の印・窓の中の印・GC・ヒープが載る', async () => {
    notePhase('test:culprit');
    const stall = await watchOnce(() => busy(300));
    const text = describeLoopStall(stall);

    expect(text).toContain(`${String(stall.stalledMs)}ms 止まった`);
    expect(text).toContain('直前の印: test:culprit');
    expect(text).toContain('窓の中で通った印は無い');
    expect(text).toMatch(/窓の中の GC: \d+ 回・合計 \d+ms・最大 \d+ms/);
    expect(text).toMatch(/ヒープ \d+\/\d+MB・RSS \d+MB/);
  });

  it('閾値に満たない遅れでは知らせない', async () => {
    const stalls: LoopStall[] = [];
    stop = startLoopStallWatch({
      intervalMs: 20,
      thresholdMs: 500,
      onStall: (s) => stalls.push(s),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    busy(100);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stalls).toEqual([]);
  });
});

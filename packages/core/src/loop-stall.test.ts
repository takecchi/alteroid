import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import {
  describeLoopStall,
  markStreamWrites,
  notePhase,
  readCgroupCpuThrottle,
  startLoopStallWatch,
  type CpuThrottleSample,
  type LoopStall,
} from './loop-stall.js';

// 偽の時計で「止まった」を作る: 実時間でループを塞ぐと、器が混んだときに揺れ、実時間の待ちを試験に足すことにもなるため
let now = 0;
let stop: (() => void) | undefined;
let stalls: LoopStall[] = [];
// CPU 時間（µs）と器の絞りも偽にする: 実物の値は器ごとに揺れるため
let cpu = { user: 0, system: 0 };
let throttle: CpuThrottleSample | undefined = { throttledUsec: 0, nrThrottled: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  stalls = [];
  cpu = { user: 0, system: 0 };
  throttle = { throttledUsec: 0, nrThrottled: 0 };
  stop = startLoopStallWatch({
    intervalMs: 500,
    thresholdMs: 1_000,
    now: () => now,
    cpuUsage: () => ({ ...cpu }),
    readCpuThrottle: async () => throttle,
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

  it('文言に、止まった長さ・直前の印・窓の中の印が無いこと・GC・CPU・器の絞り・ヒープが載る', async () => {
    notePhase('test:culprit');
    await tick();
    await stalledTick(2_000);

    const text = describeLoopStall(stalls[0] as LoopStall);
    expect(text).toContain('2000ms 止まった');
    expect(text).toContain('直前の印: test:culprit');
    expect(text).toContain('窓の中で通った印は無い');
    expect(text).toMatch(/窓の中の GC: \d+ 回・合計 \d+ms・最大 \d+ms/);
    expect(text).toContain('窓 2500ms の中でこのプロセスが使った CPU: user 0ms・system 0ms');
    expect(text).toMatch(/器の CPU の絞り（直近 \d+ms）: 0ms・0 周期/);
    expect(text).toMatch(/ヒープ \d+\/\d+MB・RSS \d+MB/);
  });

  // 印も GC も無い停止を3つに分ける: このプロセスが計算していた／動けなかった（器の絞り）／どちらでもない（同期の待ち）
  it('窓の中でこのプロセスが使った CPU 時間と、器の絞りの増分を返す', async () => {
    await tick();
    await stalledTick(1_000, () => {
      cpu = { user: cpu.user + 1_200_000, system: cpu.system + 30_000 };
      throttle = { throttledUsec: 900_000, nrThrottled: 9 };
    });

    const stall = stalls[0] as LoopStall;
    expect(stall.windowMs).toBe(1_500);
    expect(stall.cpuUserMs).toBe(1_200);
    expect(stall.cpuSystemMs).toBe(30);
    expect(stall.throttle?.throttledMs).toBe(900);
    expect(stall.throttle?.periods).toBe(9);
  });

  it('器の絞りが読めなければ欄を作らず、文言で「読めない」と言う', async () => {
    throttle = undefined;
    stop?.();
    stop = startLoopStallWatch({
      intervalMs: 500,
      thresholdMs: 1_000,
      now: () => now,
      cpuUsage: () => ({ ...cpu }),
      readCpuThrottle: async () => undefined,
      onStall: (stall) => stalls.push(stall),
    });
    await tick();
    await stalledTick(1_200);

    const stall = stalls[0] as LoopStall;
    expect(stall).not.toHaveProperty('throttle');
    expect(describeLoopStall(stall)).toContain('器の CPU の絞り: 読めない。');
  });

  it('閾値に満たない遅れでは知らせない', async () => {
    await tick();
    await stalledTick(900);
    await tick();
    expect(stalls).toEqual([]);
  });

  it('書き込みを包むと、書き込みの中で止まった回は「書き込みの印の後に止まり、終わりの印が窓の終わりに出る」形で残る。元へ戻せる', async () => {
    const written: unknown[] = [];
    const stream = {
      write: (chunk: unknown) => {
        written.push(chunk);
        // 同期の書き込みがパイプの詰まりで 2 秒待った形
        now += 2_000;
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const original = stream.write;
    const restore = markStreamWrites(stream, 'stderr-write');

    await tick();
    await stalledTick(2_000, () => {
      stream.write('hello');
      now -= 2_000;
    });

    expect(written).toEqual(['hello']);
    const stall = stalls[0] as LoopStall;
    expect(stall.phaseBefore).toBe('stderr-write:5');
    expect(stall.phasesDuring).toEqual([{ label: 'stderr-write-done', offsetMs: 2_000 }]);

    restore();
    expect(stream.write).toBe(original);
  });
});

describe('readCgroupCpuThrottle', () => {
  it('cpu.stat の throttled_usec と nr_throttled を読み、無い・読めないときは undefined', async () => {
    const dir = makeTempDirSync('alteroid-cpu-stat-');
    const full = join(dir, 'full');
    writeFileSync(
      full,
      'usage_usec 100\nuser_usec 60\nsystem_usec 40\nnr_periods 50\nnr_throttled 7\nthrottled_usec 123456\n',
    );
    const partial = join(dir, 'partial');
    writeFileSync(partial, 'usage_usec 100\n');

    expect(await readCgroupCpuThrottle(full)).toEqual({ throttledUsec: 123_456, nrThrottled: 7 });
    expect(await readCgroupCpuThrottle(partial)).toBeUndefined();
    expect(await readCgroupCpuThrottle(join(dir, 'missing'))).toBeUndefined();
  });
});

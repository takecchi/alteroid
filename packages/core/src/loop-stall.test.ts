import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import {
  describeLoopStall,
  markStreamWrites,
  notePhase,
  readCgroupCpuThrottle,
  readCgroupMemoryEvents,
  readCgroupPressure,
  startLoopStallWatch,
  type CpuThrottleSample,
  type LoopStall,
  type MemoryEventsSample,
  type PressureSample,
} from './loop-stall.js';
import type { ThreadpoolWait } from './threadpool-wait.js';

// 偽の時計で「止まった」を作る: 実時間でループを塞ぐと、器が混んだときに揺れ、実時間の待ちを試験に足すことにもなるため
let now = 0;
let stop: (() => void) | undefined;
let stalls: LoopStall[] = [];
// CPU 時間（µs）と器の絞りも偽にする: 実物の値は器ごとに揺れるため
let cpu = { user: 0, system: 0 };
let throttle: CpuThrottleSample | undefined = { throttledUsec: 0, nrThrottled: 0 };
let threadpoolWait: ThreadpoolWait | undefined = { waitedMs: 3, settled: true };
// 器の圧迫と memory.events（#4967）も偽にする。既定は読めない器
let pressure: PressureSample | undefined;
let memoryEvents: MemoryEventsSample | undefined;

beforeEach(() => {
  threadpoolWait = { waitedMs: 3, settled: true };
  vi.useFakeTimers();
  now = 0;
  stalls = [];
  cpu = { user: 0, system: 0 };
  throttle = { throttledUsec: 0, nrThrottled: 0 };
  pressure = undefined;
  memoryEvents = undefined;
  stop = startLoopStallWatch({
    intervalMs: 500,
    thresholdMs: 1_000,
    now: () => now,
    cpuUsage: () => ({ ...cpu }),
    readCpuThrottle: async () => throttle,
    readPressure: async () => pressure,
    readMemoryEvents: async () => memoryEvents,
    // 実物の枠の待ちは実 I/O で、偽の時計では進まない
    measureThreadpoolWait: async () => threadpoolWait,
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
      readPressure: async () => undefined,
      readMemoryEvents: async () => undefined,
      measureThreadpoolWait: async () => threadpoolWait,
      onStall: (stall) => stalls.push(stall),
    });
    await tick();
    await stalledTick(1_200);

    const stall = stalls[0] as LoopStall;
    expect(stall).not.toHaveProperty('throttle');
    expect(describeLoopStall(stall)).toContain('器の CPU の絞り: 読めない。');
  });

  it('器の圧迫（PSI）と memory.events の増分（ms・件数）を載せ、文に出す（#4967）', async () => {
    pressure = {
      cpu: { someUsec: 1_000_000 },
      memory: { someUsec: 0, fullUsec: 0 },
      io: { someUsec: 5_000, fullUsec: 1_000 },
    };
    memoryEvents = { high: 1, max: 0, oom: 0, oomKill: 0 };
    stop?.();
    stop = startLoopStallWatch({
      intervalMs: 500,
      thresholdMs: 1_000,
      now: () => now,
      cpuUsage: () => ({ ...cpu }),
      readCpuThrottle: async () => throttle,
      readPressure: async () => pressure,
      readMemoryEvents: async () => memoryEvents,
      measureThreadpoolWait: async () => threadpoolWait,
      onStall: (stall) => stalls.push(stall),
    });
    await tick();
    await stalledTick(1_000, () => {
      pressure = {
        cpu: { someUsec: 2_400_000 },
        memory: { someUsec: 700_400, fullUsec: 300_000 },
        io: { someUsec: 5_000, fullUsec: 1_000 },
      };
      memoryEvents = { high: 4, max: 2, oom: 1, oomKill: 1 };
    });

    const stall = stalls[0] as LoopStall;
    expect(stall.pressure).toMatchObject({
      cpuSomeMs: 1_400,
      memorySomeMs: 700,
      memoryFullMs: 300,
      ioSomeMs: 0,
      ioFullMs: 0,
    });
    expect(stall.pressure).not.toHaveProperty('cpuFullMs');
    expect(stall.pressure?.sinceMs).toBeGreaterThan(0);
    expect(stall.memoryEvents).toMatchObject({ high: 3, max: 2, oom: 1, oomKill: 1 });
    const text = describeLoopStall(stall);
    expect(text).toMatch(
      /器の圧迫（直近 \d+ms）: CPU 待ち some 1400ms \/ メモリ待ち some 700ms・full 300ms \/ I\/O 待ち some 0ms・full 0ms/,
    );
    expect(text).toContain('ホストの CPU の取り合い');
    expect(text).toMatch(/メモリの上限の出来事（直近 \d+ms）: high 3・max 2・oom 1・oom_kill 1/);
  });

  it('器の圧迫と memory.events が読めない器では欄も文も無い（0 を作らない）（#4967）', async () => {
    await tick();
    await stalledTick(1_200);

    const stall = stalls[0] as LoopStall;
    expect(stall).not.toHaveProperty('pressure');
    expect(stall).not.toHaveProperty('memoryEvents');
    const text = describeLoopStall(stall);
    expect(text).not.toContain('器の圧迫');
    expect(text).not.toContain('メモリの上限の出来事');
  });

  it('知らせる時点のスレッドの枠の待ちが文言に載る。測れなかった回は「不明」と書く（#4890）', async () => {
    await tick();
    await stalledTick(1_200);
    expect(describeLoopStall(stalls[0] as LoopStall)).toContain('スレッドの枠の待ち 3ms');

    threadpoolWait = undefined;
    await tick();
    await stalledTick(1_200);
    expect(stalls[1]).not.toHaveProperty('threadpoolWait');
    expect(describeLoopStall(stalls[1] as LoopStall)).toContain('スレッドの枠の待ち: 不明');
  });

  it('窓の始めと終わりの resourceUsage の差分を返し、文言に載せる（#4906）', async () => {
    let usage: NodeJS.ResourceUsage = { ...process.resourceUsage() };
    stop?.();
    stop = startLoopStallWatch({
      intervalMs: 500,
      thresholdMs: 1_000,
      now: () => now,
      cpuUsage: () => ({ ...cpu }),
      resourceUsage: () => ({ ...usage }),
      readCpuThrottle: async () => throttle,
      readPressure: async () => undefined,
      readMemoryEvents: async () => undefined,
      measureThreadpoolWait: async () => threadpoolWait,
      onStall: (stall) => stalls.push(stall),
    });
    // 窓より前の増分は差分に入らない
    usage = { ...usage, majorPageFault: usage.majorPageFault + 100, fsRead: usage.fsRead + 50 };
    await tick();
    await stalledTick(1_500, () => {
      usage = {
        ...usage,
        majorPageFault: usage.majorPageFault + 7,
        minorPageFault: usage.minorPageFault + 11,
        fsRead: usage.fsRead + 3,
        fsWrite: usage.fsWrite + 2,
        voluntaryContextSwitches: usage.voluntaryContextSwitches + 5,
        involuntaryContextSwitches: usage.involuntaryContextSwitches + 1,
      };
    });

    const stall = stalls[0] as LoopStall;
    expect(stall.resourceUsage).toEqual({
      majorPageFault: 7,
      minorPageFault: 11,
      fsRead: 3,
      fsWrite: 2,
      voluntaryContextSwitches: 5,
      involuntaryContextSwitches: 1,
    });
    const text = describeLoopStall(stall);
    expect(text).toContain('ページの読み戻し 7 回（軽いもの 11 回）');
    expect(text).toContain('ファイルの読み 3 回・書き 2 回');
    expect(text).toContain('自発の切り替え 5・非自発 1');
    expect(text).toContain('同期の I/O の待ち');
  });

  it('resourceUsage が無い環境では欄ごと省く（#4906）', async () => {
    stop?.();
    stop = startLoopStallWatch({
      intervalMs: 500,
      thresholdMs: 1_000,
      now: () => now,
      cpuUsage: () => ({ ...cpu }),
      resourceUsage: () => undefined,
      readCpuThrottle: async () => throttle,
      readPressure: async () => undefined,
      readMemoryEvents: async () => undefined,
      measureThreadpoolWait: async () => threadpoolWait,
      onStall: (stall) => stalls.push(stall),
    });
    await tick();
    await stalledTick(1_200);

    const stall = stalls[0] as LoopStall;
    expect(stall).not.toHaveProperty('resourceUsage');
    expect(describeLoopStall(stall)).not.toContain('窓の中の資源');
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

describe('readCgroupPressure / readCgroupMemoryEvents（#4967）', () => {
  const psi = (some: number, full?: number): string =>
    `some avg10=0.00 avg60=0.00 avg300=0.00 total=${String(some)}\n` +
    (full === undefined ? '' : `full avg10=0.00 avg60=0.00 avg300=0.00 total=${String(full)}\n`);

  it('some / full の total を読む。cpu.pressure に full が無い形も読める', async () => {
    const dir = makeTempDirSync('alteroid-psi-');
    writeFileSync(join(dir, 'cpu.pressure'), psi(123_456));
    writeFileSync(join(dir, 'memory.pressure'), psi(2_000, 1_000));
    writeFileSync(join(dir, 'io.pressure'), psi(30, 20));

    expect(await readCgroupPressure(dir)).toEqual({
      cpu: { someUsec: 123_456 },
      memory: { someUsec: 2_000, fullUsec: 1_000 },
      io: { someUsec: 30, fullUsec: 20 },
    });
  });

  it('読めないファイルの欄は省き、全部読めなければ undefined', async () => {
    const dir = makeTempDirSync('alteroid-psi-');
    writeFileSync(join(dir, 'memory.pressure'), psi(5, 4));
    writeFileSync(join(dir, 'io.pressure'), 'garbage\n');

    expect(await readCgroupPressure(dir)).toEqual({ memory: { someUsec: 5, fullUsec: 4 } });
    expect(await readCgroupPressure(join(dir, 'missing'))).toBeUndefined();
  });

  it('memory.events の high / max / oom / oom_kill を読み、読めなければ undefined', async () => {
    const dir = makeTempDirSync('alteroid-mem-events-');
    const file = join(dir, 'memory.events');
    writeFileSync(file, 'low 0\nhigh 7\nmax 3\noom 2\noom_kill 1\noom_group_kill 0\n');
    const partial = join(dir, 'partial');
    writeFileSync(partial, 'high 1\n');

    expect(await readCgroupMemoryEvents(file)).toEqual({ high: 7, max: 3, oom: 2, oomKill: 1 });
    expect(await readCgroupMemoryEvents(partial)).toBeUndefined();
    expect(await readCgroupMemoryEvents(join(dir, 'missing'))).toBeUndefined();
  });
});

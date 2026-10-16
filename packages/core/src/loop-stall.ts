import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';

import {
  describeThreadpoolWait,
  measureThreadpoolWait,
  type ThreadpoolWait,
} from './threadpool-wait.js';

/**
 * プロセスのイベントループが止まった（同期の処理・GC）ことを、止まった後に検知して、何が走っていたかを添えて知らせる（#4485）。
 *
 * 止まっている最中は何も走らないので、その場で原因を採ることはできない。代わりに、処理の要所に `notePhase` で軽い印を残しておき、
 * 止まった窓の直前と最中に通った印を、時刻の差とともに返す。GC の停止も同じ窓で合計する（使用率の 100% は GC でも出るため）。
 *
 * 窓の中でこのプロセスが使った CPU 時間と、器（cgroup）に CPU を絞られた量も添える: 印も GC も無い停止は、
 * (1) このプロセスが印の無い所で計算していた、(2) 同期の待ち（ネイティブ・システムコール）、(3) 器の CPU の上限で動けなかった、
 * のどれでも同じ形に見えるため（デーモンの器には、クローンの CLI とその Bash の子が同居していて、器の CPU を分け合っている）。
 */

// 窓の中の印を数十本は持てる長さ。古い印は捨てる
const PHASE_RING = 256;
const GC_RING = 256;
// 1件の知らせに載せる印の上限: 日誌の1行を印で埋めないため
const PHASES_SHOWN = 30;

interface PhaseMark {
  readonly at: number;
  readonly label: string;
}

interface GcMark {
  readonly at: number;
  readonly durationMs: number;
}

const phases: PhaseMark[] = [];
const gcs: GcMark[] = [];
// 印と見張りは同じ時計で測る（試験で見張りに時計を渡すと、印もその時計に揃う）
const defaultClock = (): number => performance.now();
let clock: () => number = defaultClock;

/** 処理の要所に印を残す。文字列を1つ積むだけで、計測そのものは止まった後にしか走らない。 */
export function notePhase(label: string): void {
  phases.push({ at: clock(), label });
  if (phases.length > PHASE_RING) phases.splice(0, phases.length - PHASE_RING);
}

/**
 * `stream.write` を包み、書き込みの前後に印を打つ（#4485）。返り値で元へ戻す。
 * 標準エラーに掛ける: Linux ではパイプの標準エラーは同期で書かれ、ログの取り込みが詰まると CPU を使わずにループを止めうるため。
 * 止まった窓が `stderr-write:<長さ>` の後に始まり、`stderr-write-done` が窓の中の終わり近くに出れば、止めていたのは書き込みである。
 * 長さは文字数（Buffer ならバイト数）で、バイト数を数え直さない: 大きい文字列の数え直しそのものがループを塞ぐため。
 */
export function markStreamWrites(stream: NodeJS.WritableStream, label: string): () => void {
  const original = stream.write;
  const marked = (chunk: unknown, ...rest: unknown[]): boolean => {
    const length =
      typeof chunk === 'string' ? chunk.length : chunk instanceof Uint8Array ? chunk.byteLength : 0;
    notePhase(`${label}:${String(length)}`);
    try {
      return (original as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
    } finally {
      notePhase(`${label}-done`);
    }
  };
  stream.write = marked as typeof stream.write;
  return () => {
    stream.write = original;
  };
}

export interface LoopStall {
  /** 予定の時刻から遅れた長さ（ms）。 */
  readonly stalledMs: number;
  /** 止まり始めたと見られる時刻（最後に見張りが回った時刻）。 */
  readonly since: string;
  /** 止まり始めより前に最後に通った印。 */
  readonly phaseBefore?: string;
  /** 止まっていた窓の中で通った印（止まり始めからの経過 ms 付き。古い順）。 */
  readonly phasesDuring: readonly { readonly label: string; readonly offsetMs: number }[];
  /** 窓の中で通った印のうち、載せきれなかった本数。 */
  readonly phasesOmitted: number;
  readonly gcCount: number;
  readonly gcTotalMs: number;
  readonly gcMaxMs: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly rssMb: number;
  /**
   * 窓（最後に見張りが回ってから、止まった後に回るまで）の中で、このプロセス自身が使った CPU 時間（ms。`process.cpuUsage()` の差）。
   * 窓の長さに近ければ、このプロセスが計算していた（同期の JS かネイティブ）。ずっと小さければ、動けなかった
   * （器の CPU の絞り・同期の待ち・ホストの都合）。
   */
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  /** 窓の長さ（ms）。`cpuUserMs` / `cpuSystemMs` と比べるための分母。 */
  readonly windowMs: number;
  /**
   * 器（cgroup）に CPU を絞られた量の、直前の読み取りからの増分。読めない器では無い。
   * 読み取りは数秒ごとなので、窓ぴったりではなく「窓を含む直近の数秒」である（`sinceMs`）。
   */
  readonly throttle?: {
    readonly sinceMs: number;
    readonly throttledMs: number;
    readonly periods: number;
  };
  /**
   * 器（cgroup v2 の PSI）の圧迫の待ち時間の、直前の読み取りからの増分（#4967。µs の差を ms に丸めたもの）。
   * `some` はいずれかのタスクが待たされた時間、`full` は全タスクが待たされた時間。読めなかった種類は欄ごと無い（0 を作らない）。
   * 読み方: CPU が窓に近ければホストの CPU の取り合い、メモリならメモリの回収の待ち、I/O なら I/O の待ち。
   */
  readonly pressure?: {
    readonly sinceMs: number;
    readonly cpuSomeMs?: number;
    readonly cpuFullMs?: number;
    readonly memorySomeMs?: number;
    readonly memoryFullMs?: number;
    readonly ioSomeMs?: number;
    readonly ioFullMs?: number;
  };
  /** `memory.events` の `high` / `max` / `oom` / `oom_kill` の、直前の読み取りからの増分（#4967）。読めない器では無い。 */
  readonly memoryEvents?: {
    readonly sinceMs: number;
    readonly high: number;
    readonly max: number;
    readonly oom: number;
    readonly oomKill: number;
  };
  /**
   * 知らせる時点（止まりが明けた直後）のスレッドの枠の待ち（#4890）。枠が塞がっていると、CPU を使わずループも空いたまま、
   * 名前解決と接続だけが待たされる。測れなかった回は無い（文では「不明」）。
   */
  readonly threadpoolWait?: ThreadpoolWait;
  /**
   * 窓の中の `process.resourceUsage()` の差分（#4906）。CPU を使わずに止まったとき、ページの読み戻しの待ちか同期の I/O の待ちかを見分ける。
   * 読み方: `majorPageFault` が多ければページの読み戻し（スワップ・ページキャッシュの追い出し）。少なくて
   * `voluntaryContextSwitches` があれば、同期の I/O（`*Sync`）の待ち。`resourceUsage` の無い環境では無い。
   */
  readonly resourceUsage?: ResourceUsageDelta;
}

/** `process.resourceUsage()` の2点の差分のうち、止まりの切り分けに使う6つ。 */
export interface ResourceUsageDelta {
  readonly majorPageFault: number;
  readonly minorPageFault: number;
  readonly fsRead: number;
  readonly fsWrite: number;
  readonly voluntaryContextSwitches: number;
  readonly involuntaryContextSwitches: number;
}

/** cgroup v2 の `cpu.stat` から読む2つ。 */
export interface CpuThrottleSample {
  readonly throttledUsec: number;
  readonly nrThrottled: number;
}

/** PSI の1ファイルの `some` / `full` の `total`（µs）。`cpu.pressure` の `full` は無いカーネルがある。 */
export interface PressureTotals {
  readonly someUsec: number;
  readonly fullUsec?: number;
}

/** cgroup v2 の `cpu.pressure` / `memory.pressure` / `io.pressure`。読めなかったファイルの欄は無い。 */
export interface PressureSample {
  readonly cpu?: PressureTotals;
  readonly memory?: PressureTotals;
  readonly io?: PressureTotals;
}

/** cgroup v2 の `memory.events` から読む4つ。 */
export interface MemoryEventsSample {
  readonly high: number;
  readonly max: number;
  readonly oom: number;
  readonly oomKill: number;
}

export interface LoopStallWatchOptions {
  readonly onStall: (stall: LoopStall) => void;
  /** 見張りの周期。 */
  readonly intervalMs?: number;
  /** この長さ以上遅れたら知らせる。 */
  readonly thresholdMs?: number;
  /** 単調な時計（ms）。試験で差し替える。既定は `performance.now()`。 */
  readonly now?: () => number;
  /** プロセスの CPU 時間。試験で差し替える。既定は `process.cpuUsage()`。 */
  readonly cpuUsage?: () => NodeJS.CpuUsage;
  /** プロセスの資源の使用量（#4906）。試験で差し替える。既定は `process.resourceUsage()`。無い環境では `undefined`（欄ごと省く）。 */
  readonly resourceUsage?: () => NodeJS.ResourceUsage | undefined;
  /** 器の CPU の絞りを読む口。既定は {@link readCgroupCpuThrottle}。読めなければ `undefined`（行に載せない）。 */
  readonly readCpuThrottle?: () => Promise<CpuThrottleSample | undefined>;
  /** 絞りを読んでおく周期（止まっていない間に読んでおき、止まった後に読んだ値との差を出す）。 */
  readonly throttleSampleMs?: number;
  /** 器の圧迫（PSI）を読む口（#4967）。既定は {@link readCgroupPressure}。読めなければ `undefined`（欄ごと省く）。 */
  readonly readPressure?: () => Promise<PressureSample | undefined>;
  /** `memory.events` を読む口（#4967）。既定は {@link readCgroupMemoryEvents}。読めなければ `undefined`（欄ごと省く）。 */
  readonly readMemoryEvents?: () => Promise<MemoryEventsSample | undefined>;
  /** スレッドの枠の待ちを測る口。試験で差し替える。既定は {@link measureThreadpoolWait}。 */
  readonly measureThreadpoolWait?: () => Promise<ThreadpoolWait | undefined>;
}

const DEFAULT_INTERVAL_MS = 500;
// 名乗りの確認の期限（5 秒）より十分短く、ふだんの揺れ（数十 ms）より十分長い
const DEFAULT_THRESHOLD_MS = 1_000;
// GC の観測は非同期に届くので、止まった窓の GC が積まれるのを待ってから数える
const GC_SETTLE_MS = 50;
const DEFAULT_THROTTLE_SAMPLE_MS = 5_000;

const toMb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

/** cgroup v2 の `cpu.stat`。器の中では自分の cgroup が根に見える。読めない・欄が無ければ `undefined`。 */
export async function readCgroupCpuThrottle(
  path = '/sys/fs/cgroup/cpu.stat',
): Promise<CpuThrottleSample | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    const value = (key: string): number | undefined => {
      const line = text.split('\n').find((row) => row.startsWith(`${key} `));
      const parsed = line === undefined ? NaN : Number(line.slice(key.length + 1));
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const throttledUsec = value('throttled_usec');
    const nrThrottled = value('nr_throttled');
    if (throttledUsec === undefined || nrThrottled === undefined) return undefined;
    return { throttledUsec, nrThrottled };
  } catch {
    return undefined;
  }
}

async function readPressureFile(path: string): Promise<PressureTotals | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    const total = (kind: string): number | undefined => {
      const line = text.split('\n').find((row) => row.startsWith(`${kind} `));
      const match = line === undefined ? null : /(?:^|\s)total=(\d+)/.exec(line);
      return match === null ? undefined : Number(match[1]);
    };
    const someUsec = total('some');
    if (someUsec === undefined) return undefined;
    const fullUsec = total('full');
    return fullUsec === undefined ? { someUsec } : { someUsec, fullUsec };
  } catch {
    return undefined;
  }
}

/** cgroup v2 の PSI（#4967）。ファイルごとに読めなければその欄を省き、全部読めなければ `undefined`。 */
export async function readCgroupPressure(
  dir = '/sys/fs/cgroup',
): Promise<PressureSample | undefined> {
  const [cpu, memory, io] = await Promise.all([
    readPressureFile(join(dir, 'cpu.pressure')),
    readPressureFile(join(dir, 'memory.pressure')),
    readPressureFile(join(dir, 'io.pressure')),
  ]);
  if (cpu === undefined && memory === undefined && io === undefined) return undefined;
  return {
    ...(cpu === undefined ? {} : { cpu }),
    ...(memory === undefined ? {} : { memory }),
    ...(io === undefined ? {} : { io }),
  };
}

/** cgroup v2 の `memory.events`（#4967）。読めない・欄が無ければ `undefined`。 */
export async function readCgroupMemoryEvents(
  path = '/sys/fs/cgroup/memory.events',
): Promise<MemoryEventsSample | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    const value = (key: string): number | undefined => {
      const line = text.split('\n').find((row) => row.startsWith(`${key} `));
      const parsed = line === undefined ? NaN : Number(line.slice(key.length + 1));
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const high = value('high');
    const max = value('max');
    const oom = value('oom');
    const oomKill = value('oom_kill');
    if (high === undefined || max === undefined || oom === undefined || oomKill === undefined)
      return undefined;
    return { high, max, oom, oomKill };
  } catch {
    return undefined;
  }
}

const usecToMs = (before: number, after: number): number =>
  Math.round(Math.max(0, after - before) / 1000);

function diffPressure(
  before: { at: number; sample: PressureSample } | undefined,
  after: PressureSample | undefined,
  nowMs: number,
): LoopStall['pressure'] {
  if (before === undefined || after === undefined) return undefined;
  const part = (
    b: PressureTotals | undefined,
    a: PressureTotals | undefined,
  ): { some?: number; full?: number } => {
    if (b === undefined || a === undefined) return {};
    return {
      some: usecToMs(b.someUsec, a.someUsec),
      ...(b.fullUsec === undefined || a.fullUsec === undefined
        ? {}
        : { full: usecToMs(b.fullUsec, a.fullUsec) }),
    };
  };
  const cpu = part(before.sample.cpu, after.cpu);
  const memory = part(before.sample.memory, after.memory);
  const io = part(before.sample.io, after.io);
  const fields = {
    ...(cpu.some === undefined ? {} : { cpuSomeMs: cpu.some }),
    ...(cpu.full === undefined ? {} : { cpuFullMs: cpu.full }),
    ...(memory.some === undefined ? {} : { memorySomeMs: memory.some }),
    ...(memory.full === undefined ? {} : { memoryFullMs: memory.full }),
    ...(io.some === undefined ? {} : { ioSomeMs: io.some }),
    ...(io.full === undefined ? {} : { ioFullMs: io.full }),
  };
  if (Object.keys(fields).length === 0) return undefined;
  return { sinceMs: Math.round(nowMs - before.at), ...fields };
}

function diffMemoryEvents(
  before: { at: number; sample: MemoryEventsSample } | undefined,
  after: MemoryEventsSample | undefined,
  nowMs: number,
): LoopStall['memoryEvents'] {
  if (before === undefined || after === undefined) return undefined;
  const d = (key: keyof MemoryEventsSample): number => Math.max(0, after[key] - before.sample[key]);
  return {
    sinceMs: Math.round(nowMs - before.at),
    high: d('high'),
    max: d('max'),
    oom: d('oom'),
    oomKill: d('oomKill'),
  };
}

/** 見張りを始める。返り値で止める。タイマーは unref するので、これだけでプロセスを引き止めない。 */
export function startLoopStallWatch(options: LoopStallWatchOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
  const resourceUsage = options.resourceUsage ?? defaultResourceUsage;
  const readCpuThrottle = options.readCpuThrottle ?? (() => readCgroupCpuThrottle());
  const readPressure = options.readPressure ?? (() => readCgroupPressure());
  const readMemoryEvents = options.readMemoryEvents ?? (() => readCgroupMemoryEvents());
  const measureWait = options.measureThreadpoolWait ?? (() => measureThreadpoolWait());
  clock = options.now ?? defaultClock;
  // 始める前の印は捨てる: 別の時計で打った印が窓に紛れ込まないため
  phases.length = 0;
  gcs.length = 0;

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcs.push({ at: entry.startTime, durationMs: entry.duration });
    }
    if (gcs.length > GC_RING) gcs.splice(0, gcs.length - GC_RING);
  });
  observer.observe({ entryTypes: ['gc'] });

  // 止まっていない間に絞りを読んでおく: 止まった後に読んだ値との差が「窓を含む直近の数秒」の絞りになる
  let lastThrottle: { at: number; sample: CpuThrottleSample } | undefined;
  let sampling = false;
  const sampleThrottle = (): void => {
    if (sampling) return;
    sampling = true;
    const at = clock();
    void readCpuThrottle()
      .then((sample) => {
        if (sample !== undefined) lastThrottle = { at, sample };
      })
      .finally(() => {
        sampling = false;
      });
  };
  // 器の圧迫（PSI）と memory.events も同じ周期で読んでおく（#4967）
  let lastPressure: { at: number; sample: PressureSample } | undefined;
  let lastMemoryEvents: { at: number; sample: MemoryEventsSample } | undefined;
  let samplingExtra = false;
  const sampleExtra = (): void => {
    if (samplingExtra) return;
    samplingExtra = true;
    const at = clock();
    void Promise.all([
      readPressure().catch(() => undefined),
      readMemoryEvents().catch(() => undefined),
    ])
      .then(([pressureSample, eventsSample]) => {
        if (pressureSample !== undefined) lastPressure = { at, sample: pressureSample };
        if (eventsSample !== undefined) lastMemoryEvents = { at, sample: eventsSample };
      })
      .finally(() => {
        samplingExtra = false;
      });
  };
  const sampleAll = (): void => {
    sampleThrottle();
    sampleExtra();
  };
  sampleAll();
  const throttleTimer = setInterval(
    sampleAll,
    options.throttleSampleMs ?? DEFAULT_THROTTLE_SAMPLE_MS,
  );
  throttleTimer.unref();

  let last = clock();
  let lastCpu = cpuUsage();
  let lastRusage = resourceUsage();
  const timer = setInterval(() => {
    const now = clock();
    const from = last;
    last = now;
    // 毎周取る: 窓の中の CPU 時間は、止まり始めの直前の周との差でしか出せないため（`process.cpuUsage()` は軽い）
    const cpu = cpuUsage();
    const cpuDelta = { user: cpu.user - lastCpu.user, system: cpu.system - lastCpu.system };
    lastCpu = cpu;
    // CPU と同じく毎周取る（#4906）: 窓の始めの値は止まり始めの直前の周でしか取れない
    const rusage = resourceUsage();
    const rusageDelta =
      rusage === undefined || lastRusage === undefined
        ? undefined
        : diffResourceUsage(lastRusage, rusage);
    lastRusage = rusage;
    const stalledMs = now - from - intervalMs;
    if (stalledMs < thresholdMs) return;
    const before = lastThrottle;
    const beforePressure = lastPressure;
    const beforeEvents = lastMemoryEvents;
    const settle = setTimeout(() => {
      void Promise.all([
        readCpuThrottle().catch(() => undefined),
        readPressure().catch(() => undefined),
        readMemoryEvents().catch(() => undefined),
      ]).then(async ([after, afterPressure, afterEvents]) => {
        const pressure = diffPressure(beforePressure, afterPressure, clock());
        const memoryEvents = diffMemoryEvents(beforeEvents, afterEvents, clock());
        const threadpoolWait = await measureWait().catch(() => undefined);
        const throttle =
          before === undefined || after === undefined
            ? undefined
            : {
                sinceMs: Math.round(clock() - before.at),
                throttledMs: Math.round(
                  Math.max(0, after.throttledUsec - before.sample.throttledUsec) / 1000,
                ),
                periods: Math.max(0, after.nrThrottled - before.sample.nrThrottled),
              };
        options.onStall({
          ...summarize(from, now, stalledMs, cpuDelta, throttle),
          ...(pressure === undefined ? {} : { pressure }),
          ...(memoryEvents === undefined ? {} : { memoryEvents }),
          ...(threadpoolWait === undefined ? {} : { threadpoolWait }),
          ...(rusageDelta === undefined ? {} : { resourceUsage: rusageDelta }),
        });
      });
    }, GC_SETTLE_MS);
    settle.unref();
  }, intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
    clearInterval(throttleTimer);
    observer.disconnect();
    clock = defaultClock;
  };
}

/** `process.resourceUsage` が無い・投げる環境では `undefined`（#4906）。 */
function defaultResourceUsage(): NodeJS.ResourceUsage | undefined {
  try {
    return typeof process.resourceUsage === 'function' ? process.resourceUsage() : undefined;
  } catch {
    return undefined;
  }
}

function diffResourceUsage(
  before: NodeJS.ResourceUsage,
  after: NodeJS.ResourceUsage,
): ResourceUsageDelta {
  const d = (key: keyof ResourceUsageDelta): number => Math.max(0, after[key] - before[key]);
  return {
    majorPageFault: d('majorPageFault'),
    minorPageFault: d('minorPageFault'),
    fsRead: d('fsRead'),
    fsWrite: d('fsWrite'),
    voluntaryContextSwitches: d('voluntaryContextSwitches'),
    involuntaryContextSwitches: d('involuntaryContextSwitches'),
  };
}

function summarize(
  from: number,
  to: number,
  stalledMs: number,
  cpuDelta: { user: number; system: number },
  throttle: LoopStall['throttle'],
): LoopStall {
  let phaseBefore: string | undefined;
  const during: { label: string; offsetMs: number }[] = [];
  for (const mark of phases) {
    if (mark.at <= from) phaseBefore = mark.label;
    else if (mark.at <= to)
      during.push({ label: mark.label, offsetMs: Math.round(mark.at - from) });
  }
  const shown = during.slice(0, PHASES_SHOWN);
  const inWindow = gcs.filter((gc) => gc.at + gc.durationMs > from && gc.at <= to);
  const memory = process.memoryUsage();
  return {
    stalledMs: Math.round(stalledMs),
    since: new Date(Date.now() - Math.round(clock() - from)).toISOString(),
    ...(phaseBefore === undefined ? {} : { phaseBefore }),
    phasesDuring: shown,
    phasesOmitted: during.length - shown.length,
    gcCount: inWindow.length,
    gcTotalMs: Math.round(inWindow.reduce((total, gc) => total + gc.durationMs, 0)),
    gcMaxMs: Math.round(inWindow.reduce((max, gc) => Math.max(max, gc.durationMs), 0)),
    heapUsedMb: toMb(memory.heapUsed),
    heapTotalMb: toMb(memory.heapTotal),
    rssMb: toMb(memory.rss),
    cpuUserMs: Math.round(cpuDelta.user / 1000),
    cpuSystemMs: Math.round(cpuDelta.system / 1000),
    windowMs: Math.round(to - from),
    ...(throttle === undefined ? {} : { throttle }),
  };
}

/** 窓の資源の差分の文（#4906）。読めない環境では空。読み方の注釈を添える。 */
function describeResourceUsage(usage: ResourceUsageDelta | undefined): string {
  if (usage === undefined) return '';
  return (
    `窓の中の資源: ページの読み戻し ${String(usage.majorPageFault)} 回（軽いもの ${String(usage.minorPageFault)} 回）・` +
    `ファイルの読み ${String(usage.fsRead)} 回・書き ${String(usage.fsWrite)} 回・` +
    `自発の切り替え ${String(usage.voluntaryContextSwitches)}・非自発 ${String(usage.involuntaryContextSwitches)}` +
    `（読み方: ページの読み戻しが多ければページの読み戻しの待ち。少なくて自発の切り替えがあれば同期の I/O の待ち）。`
  );
}

/** 器の圧迫（PSI）の文（#4967）。読めない回は空（文ごと出さない）。 */
function describePressure(pressure: LoopStall['pressure']): string {
  if (pressure === undefined) return '';
  const pair = (some: number | undefined, full: number | undefined): string | undefined => {
    if (some === undefined) return undefined;
    return full === undefined
      ? `some ${String(some)}ms`
      : `some ${String(some)}ms・full ${String(full)}ms`;
  };
  const parts = [
    ['CPU 待ち', pair(pressure.cpuSomeMs, pressure.cpuFullMs)],
    ['メモリ待ち', pair(pressure.memorySomeMs, pressure.memoryFullMs)],
    ['I/O 待ち', pair(pressure.ioSomeMs, pressure.ioFullMs)],
  ]
    .filter((part): part is [string, string] => part[1] !== undefined)
    .map(([label, text]) => `${label} ${text}`);
  if (parts.length === 0) return '';
  return (
    `器の圧迫（直近 ${String(pressure.sinceMs)}ms）: ${parts.join(' / ')}` +
    `（読み方: CPU 待ちが窓に近ければホストの CPU の取り合い、メモリ待ちならメモリの回収の待ち、I/O 待ちなら I/O の待ち）。`
  );
}

/** `memory.events` の増分の文（#4967）。読めない回は空。 */
function describeMemoryEvents(events: LoopStall['memoryEvents']): string {
  if (events === undefined) return '';
  return `メモリの上限の出来事（直近 ${String(events.sinceMs)}ms）: high ${String(events.high)}・max ${String(events.max)}・oom ${String(events.oom)}・oom_kill ${String(events.oomKill)}。`;
}

export function describeLoopStall(stall: LoopStall): string {
  const during =
    stall.phasesDuring.length === 0
      ? '（窓の中で通った印は無い＝直前の印の処理が止めていた見込み）'
      : stall.phasesDuring.map((mark) => `${mark.label}@+${String(mark.offsetMs)}ms`).join(' → ') +
        (stall.phasesOmitted > 0 ? ` …ほか ${String(stall.phasesOmitted)} 本` : '');
  const throttle =
    stall.throttle === undefined
      ? '器の CPU の絞り: 読めない。'
      : `器の CPU の絞り（直近 ${String(stall.throttle.sinceMs)}ms）: ${String(stall.throttle.throttledMs)}ms・${String(stall.throttle.periods)} 周期。`;
  return (
    `イベントループが ${String(stall.stalledMs)}ms 止まった（${stall.since} から）。` +
    `直前の印: ${stall.phaseBefore ?? '（無い）'}。窓の中の印: ${during}。` +
    `窓の中の GC: ${String(stall.gcCount)} 回・合計 ${String(stall.gcTotalMs)}ms・最大 ${String(stall.gcMaxMs)}ms。` +
    `窓 ${String(stall.windowMs)}ms の中でこのプロセスが使った CPU: user ${String(stall.cpuUserMs)}ms・system ${String(stall.cpuSystemMs)}ms。` +
    throttle +
    describePressure(stall.pressure) +
    describeMemoryEvents(stall.memoryEvents) +
    `${describeThreadpoolWait(stall.threadpoolWait)}。` +
    describeResourceUsage(stall.resourceUsage) +
    `ヒープ ${String(stall.heapUsedMb)}/${String(stall.heapTotalMb)}MB・RSS ${String(stall.rssMb)}MB。`
  );
}

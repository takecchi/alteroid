import { readFile } from 'node:fs/promises';
import { PerformanceObserver, performance } from 'node:perf_hooks';

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
}

/** cgroup v2 の `cpu.stat` から読む2つ。 */
export interface CpuThrottleSample {
  readonly throttledUsec: number;
  readonly nrThrottled: number;
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
  /** 器の CPU の絞りを読む口。既定は {@link readCgroupCpuThrottle}。読めなければ `undefined`（行に載せない）。 */
  readonly readCpuThrottle?: () => Promise<CpuThrottleSample | undefined>;
  /** 絞りを読んでおく周期（止まっていない間に読んでおき、止まった後に読んだ値との差を出す）。 */
  readonly throttleSampleMs?: number;
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

/** 見張りを始める。返り値で止める。タイマーは unref するので、これだけでプロセスを引き止めない。 */
export function startLoopStallWatch(options: LoopStallWatchOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
  const readCpuThrottle = options.readCpuThrottle ?? (() => readCgroupCpuThrottle());
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
  sampleThrottle();
  const throttleTimer = setInterval(
    sampleThrottle,
    options.throttleSampleMs ?? DEFAULT_THROTTLE_SAMPLE_MS,
  );
  throttleTimer.unref();

  let last = clock();
  let lastCpu = cpuUsage();
  const timer = setInterval(() => {
    const now = clock();
    const from = last;
    last = now;
    // 毎周取る: 窓の中の CPU 時間は、止まり始めの直前の周との差でしか出せないため（`process.cpuUsage()` は軽い）
    const cpu = cpuUsage();
    const cpuDelta = { user: cpu.user - lastCpu.user, system: cpu.system - lastCpu.system };
    lastCpu = cpu;
    const stalledMs = now - from - intervalMs;
    if (stalledMs < thresholdMs) return;
    const before = lastThrottle;
    const settle = setTimeout(() => {
      void readCpuThrottle()
        .catch(() => undefined)
        .then((after) => {
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
          options.onStall(summarize(from, now, stalledMs, cpuDelta, throttle));
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
    `ヒープ ${String(stall.heapUsedMb)}/${String(stall.heapTotalMb)}MB・RSS ${String(stall.rssMb)}MB。`
  );
}

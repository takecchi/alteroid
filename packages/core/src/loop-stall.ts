import { PerformanceObserver, performance } from 'node:perf_hooks';

/**
 * プロセスのイベントループが止まった（同期の処理・GC）ことを、止まった後に検知して、何が走っていたかを添えて知らせる（#4485）。
 *
 * 止まっている最中は何も走らないので、その場で原因を採ることはできない。代わりに、処理の要所に `notePhase` で軽い印を残しておき、
 * 止まった窓の直前と最中に通った印を、時刻の差とともに返す。GC の停止も同じ窓で合計する（使用率の 100% は GC でも出るため）。
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
}

export interface LoopStallWatchOptions {
  readonly onStall: (stall: LoopStall) => void;
  /** 見張りの周期。 */
  readonly intervalMs?: number;
  /** この長さ以上遅れたら知らせる。 */
  readonly thresholdMs?: number;
  /** 単調な時計（ms）。試験で差し替える。既定は `performance.now()`。 */
  readonly now?: () => number;
}

const DEFAULT_INTERVAL_MS = 500;
// 名乗りの確認の期限（5 秒）より十分短く、ふだんの揺れ（数十 ms）より十分長い
const DEFAULT_THRESHOLD_MS = 1_000;
// GC の観測は非同期に届くので、止まった窓の GC が積まれるのを待ってから数える
const GC_SETTLE_MS = 50;

const toMb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

/** 見張りを始める。返り値で止める。タイマーは unref するので、これだけでプロセスを引き止めない。 */
export function startLoopStallWatch(options: LoopStallWatchOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
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

  let last = clock();
  const timer = setInterval(() => {
    const now = clock();
    const from = last;
    last = now;
    const stalledMs = now - from - intervalMs;
    if (stalledMs < thresholdMs) return;
    const settle = setTimeout(() => {
      options.onStall(summarize(from, now, stalledMs));
    }, GC_SETTLE_MS);
    settle.unref();
  }, intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
    observer.disconnect();
    clock = defaultClock;
  };
}

function summarize(from: number, to: number, stalledMs: number): LoopStall {
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
  };
}

export function describeLoopStall(stall: LoopStall): string {
  const during =
    stall.phasesDuring.length === 0
      ? '（窓の中で通った印は無い＝直前の印の処理が止めていた見込み）'
      : stall.phasesDuring.map((mark) => `${mark.label}@+${String(mark.offsetMs)}ms`).join(' → ') +
        (stall.phasesOmitted > 0 ? ` …ほか ${String(stall.phasesOmitted)} 本` : '');
  return (
    `イベントループが ${String(stall.stalledMs)}ms 止まった（${stall.since} から）。` +
    `直前の印: ${stall.phaseBefore ?? '（無い）'}。窓の中の印: ${during}。` +
    `窓の中の GC: ${String(stall.gcCount)} 回・合計 ${String(stall.gcTotalMs)}ms・最大 ${String(stall.gcMaxMs)}ms。` +
    `ヒープ ${String(stall.heapUsedMb)}/${String(stall.heapTotalMb)}MB・RSS ${String(stall.rssMb)}MB。`
  );
}

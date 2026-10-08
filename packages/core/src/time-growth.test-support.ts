import vm from 'node:vm';

import { assert, expect } from 'vitest';

// 2点の比ではなく複数点の傾きで判定する: 2点がキャッシュや GC の段差をまたぐだけで、線形でも比が跳ねるため。
// 最小値を取る（中央値ではなく）: 器が混むと時間は足されるだけで引かれはしないため
export interface ExpectNotSuperlinearOptions {
  n: number;
  factor?: number;
  maxSlope?: number;
  hardCapMs?: number;
  floorMs?: number;
  repeats?: number;
  minSmallMs?: number;
  rounds?: number;
  warmups?: number;
  maxScale?: number;
  // 呼び出し側の歯は渡さない: 渡すと実装の伸び方を測らなくなる
  now?: () => number;
}

export interface GrowthMeasurement {
  n: number;
  sizes: number[];
  timesMs: number[];
  slopes: number[];
  medianSlope: number;
  slope: number;
  tSmallMs: number;
  tLargeMs: number;
  ratio: number;
}

function leastSquaresSlope(times: number[], floorMs: number): number {
  const ys = times.map((t) => Math.log2(Math.max(t, floorMs)));
  const mx = (ys.length - 1) / 2;
  const my = ys.reduce((a, y) => a + y, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  ys.forEach((y, x) => {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
  });
  return sxy / sxx;
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

class HungError extends Error {
  constructor(
    readonly phase: string,
    readonly size: number,
  ) {
    super(`hung: ${phase} n=${size}`);
  }
}

// Worker や子プロセスに逃がさず vm の timeout を使う: 測る時間と比が変わらず、約 65 箇所の呼び出し側が閉包を渡しており、器の pids の上限もあるため
// 時計は vm の内側の閉包で読む: vm へ入る・出るコストを t(small) / t(large) に入れないため
function makeTimer<TInput>(
  run: (input: TInput) => unknown,
  now: () => number,
  hardCapMs: number,
): (input: TInput, phase: string, size: number) => number {
  const direct = (input: TInput): number => {
    const start = now();
    run(input);
    return now() - start;
  };
  if (!Number.isFinite(hardCapMs)) return direct;

  let pending: TInput;
  let elapsedMs = 0;
  const context = vm.createContext({
    timed: (): void => {
      const start = now();
      run(pending);
      elapsedMs = now() - start;
    },
  });
  const script = new vm.Script('timed()');
  const timeout = Math.max(1, Math.ceil(hardCapMs));
  return (input, phase, size) => {
    pending = input;
    try {
      script.runInContext(context, { timeout });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new HungError(phase, size);
      }
      throw error;
    }
    return elapsedMs;
  };
}

export function expectNotSuperlinear<TInput>(
  run: (input: TInput) => unknown,
  makeInput: (n: number) => TInput,
  options: ExpectNotSuperlinearOptions,
): GrowthMeasurement {
  const {
    factor = 8,
    maxSlope = 1.6,
    hardCapMs = 2000,
    floorMs = 1,
    repeats = 5,
    minSmallMs = 5,
    rounds = 3,
    warmups = 3,
    maxScale = factor >= 4 ? 16 : 1,
    now = () => performance.now(),
  } = options;
  const steps = Math.log2(factor);
  if (!Number.isInteger(steps) || steps < 1) {
    throw new RangeError(`factor は 2 の冪（2, 4, 8, ...）であること: ${factor}`);
  }
  const pointCount = steps + 1;

  // n を倍にするかどうかは温まった後の値で決める: 温まる前の遅い値だと混んだ器で「届いている」と誤読して倍にしないため
  let n = options.n;
  let minTimes: number[] = [];
  const timeCapped = makeTimer(run, now, hardCapMs);
  const describeTimes = (): string =>
    minTimes.some((t) => Number.isFinite(t))
      ? `それまでの最小: ${minTimes
          .map((t, i) => `t(${n * 2 ** i})=${Number.isFinite(t) ? `${t.toFixed(2)}ms` : '未測定'}`)
          .join(', ')}。`
      : 'まだ最小を測り終えていない。';
  const timeOnce = (input: TInput, phase: string, size: number): number => {
    try {
      return timeCapped(input, phase, size);
    } catch (error) {
      if (!(error instanceof HungError)) throw error;
      return assert.fail(
        `固まり・指数的な後戻りの疑い —— hardCapMs を超えた。${phase}の入力 n=${size} の1回が ` +
          `hardCapMs=${hardCapMs}ms で打ち切られた（node:vm の timeout で割り込み、終わるのを待たなかった）。` +
          describeTimes() +
          `n=${n}（出発点 ${options.n}）, factor=${factor}, maxSlope=${maxSlope}`,
      );
    }
  };
  const warmedMs = (input: TInput, size: number): number => {
    let min = Infinity;
    for (let i = 0; i < warmups; i += 1) min = Math.min(min, timeOnce(input, '温め', size));
    return min;
  };
  let inputs: TInput[] = [makeInput(n)];
  let tWarm = warmedMs(inputs[0]!, n);
  while (tWarm < minSmallMs && n * 2 <= options.n * maxScale) {
    n *= 2;
    inputs = [makeInput(n)];
    tWarm = warmedMs(inputs[0]!, n);
  }
  for (let k = 1; k < pointCount; k += 1) inputs.push(makeInput(n * 2 ** k));
  const sizes = inputs.map((_, k) => n * 2 ** k);

  // ラウンドごとの傾きの最小は採らない: 小さいほうだけに混みが乗ったラウンドが1つあると傾きが下がり、2乗でも閾値を下回って通るため
  minTimes = sizes.map(() => Infinity);
  const slopesOf = (times: number[]): number[] =>
    times.slice(1).map((t, k) => Math.log2(Math.max(t, floorMs) / Math.max(times[k]!, floorMs)));
  const roundLog: string[] = [];
  let slopes: number[] = [];
  let medianSlope = Number.POSITIVE_INFINITY;
  let slope = Number.POSITIVE_INFINITY;
  let hung = false;
  for (let round = 0; round < rounds && !hung; round += 1) {
    const roundMin = sizes.map(() => Infinity);
    for (let i = 0; i < repeats && !hung; i += 1) {
      for (let k = 0; k < pointCount; k += 1) {
        const t = timeOnce(inputs[k]!, k === 0 ? '小さいほう' : '大きいほう', sizes[k]!);
        roundMin[k] = Math.min(roundMin[k]!, t);
        minTimes[k] = Math.min(minTimes[k]!, t);
        if (t >= hardCapMs) {
          minTimes[k] = t;
          hung = true;
          break;
        }
      }
    }
    minTimes = minTimes.map((t) => (Number.isFinite(t) ? t : hardCapMs));
    slopes = slopesOf(minTimes);
    medianSlope = median(slopes);
    slope = leastSquaresSlope(minTimes, floorMs);
    roundLog.push(
      `#${round + 1}: 各点の最小=[${roundMin.map((t) => t.toFixed(2)).join(', ')}]ms, ` +
        `累積の最小二乗の傾き=${slope.toFixed(2)}`,
    );
    if (hung || slope < maxSlope) break;
  }

  const detail =
    `${sizes.map((m, k) => `t(${m})=${minTimes[k]!.toFixed(2)}ms`).join(', ')}。` +
    `区間ごとの傾き=[${slopes.map((x, k) => `${sizes[k]}→${sizes[k + 1]}: ${x.toFixed(2)}`).join(', ')}], ` +
    `区間の傾きの中央値（参考）=${medianSlope.toFixed(2)}, 最小二乗の傾き=${slope.toFixed(2)}（ラウンドごと [${roundLog.join(' | ')}]。` +
    `n=${n}（出発点 ${options.n}）, factor=${factor}, maxSlope=${maxSlope}, ` +
    `hardCapMs=${hardCapMs}, repeats=${repeats}, rounds=${rounds}, 最小値）`;

  expect(
    Math.max(...minTimes),
    `固まり・指数的な後戻りの疑い —— hardCapMs を超えた。${detail}`,
  ).toBeLessThan(hardCapMs);
  expect(
    slope,
    `伸びの比が大きすぎる —— 2乗以上の後戻りの疑い（最小二乗の傾きが maxSlope 以上）。${detail}`,
  ).toBeLessThan(maxSlope);

  const tSmallMs = minTimes[0]!;
  const tLargeMs = minTimes[pointCount - 1]!;
  return {
    n,
    sizes,
    timesMs: minTimes,
    slopes,
    medianSlope,
    slope,
    tSmallMs,
    tLargeMs,
    ratio: tLargeMs / Math.max(tSmallMs, floorMs),
  };
}

import vm from 'node:vm';

import { assert, expect } from 'vitest';

/**
 * issue #2187 —— ガードと timeout の時間の歯が、壁時計の絶対値
 * （`TIME_BUDGET_MS = 200` のような固定の ms）で落ちていた。CI の器が混むと、
 * 実装の性質（線形・2乗・3乗・指数）とは無関係に壁時計だけが伸びて歯が落ちる
 * （PR #2184 で `bash-wait-guard-heredoc-scan.test.ts` の歯が実際に 248ms で
 * 落ちた——差分とは無関係、器が混んだだけの揺れ）。
 *
 * ここでは絶対値の代わりに **伸びの比** で判定する。入力の大きさ `n` と
 * `n * factor` のそれぞれで測り、`t(n * factor) / max(t(n), floorMs)` を見る
 * ——線形なら約 `factor`、2乗なら約 `factor²`、3乗なら約 `factor³` になる。
 * 器が混んで t(n) と t(n*factor) が両方とも同じだけ（一様に）遅くなっても、
 * 比そのものは変わらない。
 *
 * **比だけでは指数や完全な固まりを捕まえられない**（両方とも「同じくらい
 * 遅い」まま揺れずに固まりうる——固まった場合、片方が測り終わらない）。
 * そのため `hardCapMs`（`t(n*factor)` の絶対上限）も併用する。ここは絶対値
 * だが、`n * factor` を「壊れた実装がこれまでどおり数百 ms かかる大きさ」に
 * 選んである前提のもとで、`hardCapMs` はいまの10倍の余裕（既定 2000ms）を
 * 持たせてあるので、器の揺れだけでは踏まない設計にしてある。
 *
 * **判定の形（#3017）——2点の比から、幾何級数の複数点の log-log の最小二乗の傾きへ。** 2点（n と n*factor）の比だけで
 * 判定すると、その2点がたまたまキャッシュや GC の段差をまたいだだけで、線形の実装でも比が跳ねる
 * （`bash-wait-guard-issue-2206.test.ts`: 64000→256000 で約 6.8 倍。前後は約 4 倍。CI で比 10.1 で落ちた）。
 * そこで、`n, 2n, 4n, ..., n*factor`（既定 factor=8 で 4 点）を測り、全点の `log2 t` を `log2 n` へ
 * 最小二乗で当てはめた**傾き**を `maxSlope`（既定 1.6）と比べる。
 * 線形は約 1、n log n は約 1.1、2乗は約 2、3乗は約 3。
 * - **2乗との距離は 0.4**（2.0 − 1.6）。**線形との距離は 0.6**（1.6 − 1.0。n log n の 1.1 でも 0.5）。
 * - **段差の影響**: 点 k 以降の時間が一様に s=log2(段差の倍率) だけ上がる段差は、傾きを
 *   s × Σ_{j≥k}(x_j − x̄) / Σ(x_j − x̄)² だけ押し上げる（x_j = log2 のうちの点の番号）。4点（factor=8）で
 *   中央の区間に段差があるとき最大で s × 0.4、端の区間なら s × 0.3。1.7 倍の段差（s=0.77）で +0.31 なので、
 *   線形 + 段差は約 1.0〜1.1 + 0.31 = 1.4 以下で、1.6 に届かない。#3017 の実際の形（隣り合う2倍の区間で時間が 6.8 倍、
 *   区間の傾き約 2.8、s=1.77）は、中央の区間で +0.71 となり 1.71 で 1.6 を超える。端の区間（+0.53）は通る。
 *   5 点（factor=16）なら最大 s × 0.3 で、通る。
 * - 隣り合う区間の傾き `log2(t(2m) / t(m))` は、分母の幅が 1 しかなく、数 ms の揺れが大きく出る
 *   （実測で 0.6〜1.7）ので、判定には使わず、失敗時のメッセージと結果（`slopes` / `medianSlope`）に参考として出す。
 *
 * **使い手のオプションの扱い**: `n` / `repeats` / `rounds` / `warmups` / `minSmallMs` / `maxScale` / `floorMs` /
 * `hardCapMs` / `now` は意味を変えていない。`factor` は「最大の点は n*factor」のまま（2 の冪に限る。既定 4 → 8。
 * 点の数は log2(factor)+1）。`maxRatio`（比の上限）は廃止し、`maxSlope`（最小二乗の傾きの上限）へ替えた。
 * `hardCapMs` は**どの点でも**効く（以前は最大の点だけ）。
 *
 * **揺れへの手当て（#2194 の後に B の #2214 の CI で比 10.55 が出たため）**。t(n) が 1〜2ms しか
 * 無いと、分母が器の混み具合でぶれて、線形でも比が跳ねた（t(1000)=1.74ms, t(4000)=18.39ms。
 * 手元では同じ形が n を倍にするごとにきっちり倍になる線形である）。そこで次の3つを入れた。
 * - **最小値を取る**（中央値ではなく）。器が混むと時間は足されるだけで、引かれはしない。
 * - **小さいほうと大きいほうを交互に測る**。混み具合の波が片方にだけ乗るのを避ける。
 * - **ラウンドを繰り返し、全ラウンドを通した最小時間どうしの比で判定する**（#2576、CI run 36798057082 で比
 *   10.23）。比が閾値を超えている間だけ重ねる。ラウンドごとの比の最小は2乗を通すので採らない。
 * - **t(n) が `minSmallMs`（既定 5ms）に届くまで n を倍にする**（`maxScale` 倍まで）。
 *   2乗・3乗の実装は n を上げるほど比が理論値へ近づくので、捕まえる力は落ちない。
 *   大きいほうが `hardCapMs` を超えたら、その時点で測るのをやめて落とす。
 */
export interface ExpectNotSuperlinearOptions {
  /** 小さいほうの入力の大きさ（出発点。t(n) が `minSmallMs` に届くまで倍にする）。 */
  n: number;
  /**
   * いちばん大きい入力の大きさは `n * factor`。2 の冪（2, 4, 8, ...）に限る。測る点は
   * `n, 2n, 4n, ..., n*factor`（点の数 = log2(factor)+1）。既定 8（4 点・傾き 3 つ）。
   */
  factor?: number;
  /**
   * 全点の `log2 t` を `log2 n` へ当てはめた最小二乗の傾きの上限。既定 1.6
   * （線形は約 1、n log n は約 1.1、2乗は約 2、3乗は約 3）。
   */
  maxSlope?: number;
  /** どの点でも、1回の測定がこれ（ms）を超えたら固まりとして落とす。指数的な後戻りや完全な固まりを捕まえる。既定 2000。 */
  hardCapMs?: number;
  /** 傾きを取るとき、時間をこれ（ms）で下から切る。時間が 0 に近いときの傾きの暴れを抑える。既定 1。 */
  floorMs?: number;
  /** 最小値を取るための試行回数（全部の点を、小さいほうから順に1周ずつ測る）。既定 5。 */
  repeats?: number;
  /** t(n) がこれに届くまで n を倍にする（ms）。既定 5。0 なら倍にしない。 */
  minSmallMs?: number;
  /**
   * 測定ラウンドの最大回数（#2576）。最小二乗の傾きが `maxSlope` を超えている間だけ重ね、
   * 全ラウンドの最小時間どうしの比が超えたまま残ったときに落とす。既定 3。1 なら従来どおり1回で決める。
   */
  rounds?: number;
  /** 温めの回数（捨てる。n を倍にする判定はこの最小値で行う）。既定 3。 */
  warmups?: number;
  /**
   * n を倍にする上限（出発点の何倍まで）。既定は factor が 4 以上なら 16、それ未満なら 1（倍にしない）。
   * factor を小さくしてある歯は指数の後戻りを見る歯で、壊れた実装では n を倍にした1回が
   * 終わらない。正しい実装の t(n) は floorMs よりずっと小さく、比が跳ねる帯に入らない。
   */
  maxScale?: number;
  /**
   * 時計（ms）。既定は `performance.now`。助け自身の歯が、最小値の取り方や n の倍し方を
   * 実時間に頼らず確かめるための口（#2240: 実時間で測る自己テストが CI の混みで落ちた）。
   * 呼び出し側の歯は渡さないこと——渡すと、実装の伸び方を測らなくなる。
   */
  now?: () => number;
}

/** 測定結果——助け自身の歯や、呼び出し側の追加の検算に使う（全ラウンドの最小時間による）。 */
export interface GrowthMeasurement {
  /** 実際に測った最小の入力の大きさ（倍にした後）。 */
  n: number;
  /** 各点の入力の大きさ（`n, 2n, ..., n*factor`）。 */
  sizes: number[];
  /** 各点の最小時間（ms）。`sizes` と同じ順。 */
  timesMs: number[];
  /** 隣り合う点の傾き `log2(max(t(2m), floorMs) / max(t(m), floorMs))`。 */
  slopes: number[];
  /** `slopes` の中央値（偶数個なら中央2つの平均）。参考値で、判定には使わない。 */
  medianSlope: number;
  /** 全点の `log2(max(t, floorMs))` を `log2(大きさ)` へ当てはめた最小二乗の傾き。判定に使う。 */
  slope: number;
  /** 最小の点の最小時間（ms）。 */
  tSmallMs: number;
  /** 最大の点（`n*factor`）の最小時間（ms）。 */
  tLargeMs: number;
  /** `tLargeMs / max(tSmallMs, floorMs)`（参考値。判定には使わない）。 */
  ratio: number;
}

/** 点（大きさが 2 倍ずつ）の `log2(max(t, floorMs))` の最小二乗の傾き。x は 0, 1, 2, ...。 */
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

/** hardCapMs で打ち切られたことを、測定の外側（assertion を組み立てる所）へ運ぶ印。 */
class HungError extends Error {
  constructor(
    readonly phase: string,
    readonly size: number,
  ) {
    super(`hung: ${phase} n=${size}`);
  }
}

/**
 * 1回分の `run(input)` を測る道具。`hardCapMs` が有限なら、`node:vm` の `timeout` の下で走らせる。
 *
 * #2579 —— 指数的な後戻りの正規表現（`(a+)+$` の形）が `run` の中で走ると、同期呼び出しは
 * 戻ってこない。`hardCapMs` は `run` が戻ったあとにしか比べられないので、固まった本物の後退は
 * assertion に辿り着かず、vitest の testTimeout も（同じスレッドが塞がっているので）発火せず、
 * CI の job 全体の時間切れまで読める失敗が出なかった。
 *
 * `vm` の `timeout` は V8 の TerminateExecution で、実行中の irregexp の後戻りの最中でも割り込める。
 * Worker や子プロセスに逃がさずこれを選んだ理由:
 * - 同じスレッド・同じ isolate で走るので、測る時間と比が変わらない（スレッド起動や IPC の雑音が乗らない）。
 * - 約 65 箇所の呼び出し側は閉包を渡している。Worker/子プロセスだと、モジュールのパスを渡す形へ全部移す必要がある。
 * - プロセスを増やさない（器には pids の上限がある）。
 *
 * **時計は `vm` の内側の閉包で読む**（`vm` へ入る・出るコストを t(small) / t(large) に入れない）。
 * 文脈と Script は呼び出しごとに1つだけ作って使い回す。
 * `hardCapMs` が有限でないとき（smoke が閾値を無効にする）は `vm` の `timeout` に渡せないので、直接走らせる。
 * `run` が投げた他の例外は、そのまま呼び出し側へ伝わる。
 */
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

/**
 * `run(makeInput(m))` を `m = n, 2n, 4n, ..., n * factor` で測り、隣り合う点の傾き
 * 全点の `log2 t` の `log2 n` への最小二乗の傾きが `maxSlope` 未満（かつどの点も `hardCapMs` 未満）であることを
 * `expect` する。呼び出し側は、いまの固定入力の大きさ（繰り返しの回数）が
 * `n * factor` 以下になるよう `n` を選ぶこと（t(n) が小さければ、ここで倍にする）。
 *
 * 落ちたときの assertion メッセージに、各点の時間と各区間の傾きを生で載せる
 * ——読んだ人が「揺れで落ちたのか、本物の後退か」を、この文だけで見分け
 * られるようにするため。
 */
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

  // JIT の温め——温まる前の最初の数回は捨てる（ここで測りたいのは「温まった後」の伸び方である）。
  // **n を倍にするかどうかも、温まった後の値で決める**（#2576）。以前は最初の2回（まだ遅い）で
  // 決めていたので、混んだ器では「5ms に届いている」と誤読して倍にせず、1〜2ms の分母で比を
  // 取ることになった（CI run 36798057082: t(500)=1.79ms, t(2000)=18.35ms, 比 10.23）。
  let n = options.n;
  let minTimes: number[] = [];
  const timeCapped = makeTimer(run, now, hardCapMs);
  const describeTimes = (): string =>
    minTimes.some((t) => Number.isFinite(t))
      ? `それまでの最小: ${minTimes
          .map((t, i) => `t(${n * 2 ** i})=${Number.isFinite(t) ? `${t.toFixed(2)}ms` : '未測定'}`)
          .join(', ')}。`
      : 'まだ最小を測り終えていない。';
  // hardCapMs で打ち切られたら（#2579）、固まりの assertion として落とす。`run` の他の例外はそのまま伝わる。
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
  // t(n) が小さすぎると、分母が器の混み具合でぶれる。届くまで n を倍にする。
  while (tWarm < minSmallMs && n * 2 <= options.n * maxScale) {
    n *= 2;
    inputs = [makeInput(n)];
    tWarm = warmedMs(inputs[0]!, n);
  }
  for (let k = 1; k < pointCount; k += 1) inputs.push(makeInput(n * 2 ** k));
  const sizes = inputs.map((_, k) => n * 2 ** k);

  // **傾きは、全ラウンドを通した「各点の最小時間」から出す**（#2576）。
  // 器の混みは時間を足すだけで引かないので、最小時間は測るほど真の値へ単調に近づく。
  // ラウンドを重ねるのは、傾きが `maxSlope` を超えている間だけ（最大 `rounds` 回）。
  // **ラウンドごとの傾きの最小を採ってはいけない**——小さいほうだけに混みが乗ったラウンドが
  // 1つあると傾きが下がり、2乗でも閾値を下回って通る（ラウンドごとの比の最小が2乗を通した #2576 の形）。
  // 最小時間どうしなら、混みはどの点でも「足されるだけ」なので、2乗の傾きは理論値より下がらない。
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
        // どの点でも1回でも上限を超えたら、残りは測らない（最小値も上限を超えているとは
        // 限らないので、超えた1回の値で落とす）。
        if (t >= hardCapMs) {
          minTimes[k] = t;
          hung = true;
          break;
        }
      }
    }
    // 打ち切りで測り終えていない点は Infinity のまま残る。表示と傾きのために、上限の値で埋める。
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

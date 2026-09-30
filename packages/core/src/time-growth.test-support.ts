import { expect } from 'vitest';

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
 * **揺れへの手当て（#2194 の後に B の #2214 の CI で比 10.55 が出たため）**。t(n) が 1〜2ms しか
 * 無いと、分母が器の混み具合でぶれて、線形でも比が跳ねた（t(1000)=1.74ms, t(4000)=18.39ms。
 * 手元では同じ形が n を倍にするごとにきっちり倍になる線形である）。そこで次の3つを入れた。
 * - **最小値を取る**（中央値ではなく）。器が混むと時間は足されるだけで、引かれはしない。
 * - **小さいほうと大きいほうを交互に測る**。混み具合の波が片方にだけ乗るのを避ける。
 * - **t(n) が `minSmallMs`（既定 5ms）に届くまで n を倍にする**（`maxScale` 倍まで）。
 *   2乗・3乗の実装は n を上げるほど比が理論値へ近づくので、捕まえる力は落ちない。
 *   大きいほうが `hardCapMs` を超えたら、その時点で測るのをやめて落とす。
 */
export interface ExpectNotSuperlinearOptions {
  /** 小さいほうの入力の大きさ（出発点。t(n) が `minSmallMs` に届くまで倍にする）。 */
  n: number;
  /** 大きいほうの入力の大きさは `n * factor`。既定 4。 */
  factor?: number;
  /**
   * `t(n*factor) / max(t(n), floorMs)` の上限。既定 10
   * （線形なら約 factor、2乗なら約 factor²、3乗なら約 factor³ になるので、
   * 既定の factor=4 なら 2乗の 16 にも余裕を持って届かない 10 で切る）。
   */
  maxRatio?: number;
  /** `t(n*factor)` の絶対上限（ms）。指数的な後戻りや完全な固まりを捕まえる。既定 2000。 */
  hardCapMs?: number;
  /** 比を取るときの分母の下限（ms）。`t(n)` が 0 に近いときの比の暴れを抑える。既定 1。 */
  floorMs?: number;
  /** 最小値を取るための試行回数（小さいほうと大きいほうを交互に測る）。既定 5。 */
  repeats?: number;
  /** t(n) がこれに届くまで n を倍にする（ms）。既定 5。0 なら倍にしない。 */
  minSmallMs?: number;
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

/** 測定結果——助け自身の歯や、呼び出し側の追加の検算に使う。 */
export interface GrowthMeasurement {
  /** 実際に測った小さいほうの入力の大きさ（倍にした後）。 */
  n: number;
  /** `t(n)` の最小値（ms）。 */
  tSmallMs: number;
  /** `t(n*factor)` の最小値（ms）。 */
  tLargeMs: number;
  /** `tLargeMs / max(tSmallMs, floorMs)`。 */
  ratio: number;
}

function timeOnceMs<TInput>(
  run: (input: TInput) => unknown,
  input: TInput,
  now: () => number,
): number {
  const start = now();
  run(input);
  return now() - start;
}

/**
 * `run(makeInput(n))` と `run(makeInput(n * factor))` を測り、伸びの比が
 * `maxRatio` 未満（かつ `t(n*factor)` が `hardCapMs` 未満）であることを
 * `expect` する。呼び出し側は、いまの固定入力の大きさ（繰り返しの回数）が
 * `n * factor` と同じになるよう `n` を選ぶこと（t(n) が小さければ、ここで倍にする）。
 *
 * 落ちたときの assertion メッセージに `t(n)` / `t(n*factor)` / 比を載せる
 * ——読んだ人が「揺れで落ちたのか、本物の後退か」を、この文だけで見分け
 * られるようにするため。
 */
export function expectNotSuperlinear<TInput>(
  run: (input: TInput) => unknown,
  makeInput: (n: number) => TInput,
  options: ExpectNotSuperlinearOptions,
): GrowthMeasurement {
  const {
    factor = 4,
    maxRatio = 10,
    hardCapMs = 2000,
    floorMs = 1,
    repeats = 5,
    minSmallMs = 5,
    maxScale = factor >= 4 ? 16 : 1,
    now = () => performance.now(),
  } = options;

  // JIT の温め——最初の1回は捨てる（ここで測りたいのは「温まった後」の伸び方である）。
  let n = options.n;
  let small = makeInput(n);
  let tFirst = timeOnceMs(run, small, now);
  tFirst = Math.min(tFirst, timeOnceMs(run, small, now));
  // t(n) が小さすぎると、分母が器の混み具合でぶれる。届くまで n を倍にする。
  while (tFirst < minSmallMs && n * 2 <= options.n * maxScale) {
    n *= 2;
    small = makeInput(n);
    tFirst = timeOnceMs(run, small, now);
  }
  const large = makeInput(n * factor);

  let tSmallMs = Infinity;
  let tLargeMs = Infinity;
  for (let i = 0; i < repeats; i += 1) {
    tSmallMs = Math.min(tSmallMs, timeOnceMs(run, small, now));
    const tLarge = timeOnceMs(run, large, now);
    tLargeMs = Math.min(tLargeMs, tLarge);
    // 大きいほうが1回でも上限を超えたら、残りは測らない（最小値も上限を超えているとは
    // 限らないので、超えた1回の値で落とす）。
    if (tLarge >= hardCapMs) {
      tLargeMs = tLarge;
      break;
    }
  }
  const ratio = tLargeMs / Math.max(tSmallMs, floorMs);

  const detail =
    `t(${n})=${tSmallMs.toFixed(2)}ms, t(${n * factor})=${tLargeMs.toFixed(2)}ms, ` +
    `ratio=${ratio.toFixed(2)}（n=${n}（出発点 ${options.n}）, factor=${factor}, maxRatio=${maxRatio}, ` +
    `hardCapMs=${hardCapMs}, repeats=${repeats}, 最小値）`;

  expect(tLargeMs, `固まり・指数的な後戻りの疑い —— hardCapMs を超えた。${detail}`).toBeLessThan(
    hardCapMs,
  );
  expect(ratio, `伸びの比が大きすぎる —— 2乗以上の後戻りの疑い。${detail}`).toBeLessThan(maxRatio);

  return { n, tSmallMs, tLargeMs, ratio };
}

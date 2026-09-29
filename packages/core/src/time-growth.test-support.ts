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
 */
export interface ExpectNotSuperlinearOptions {
  /** 小さいほうの入力の大きさ。 */
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
  /** 中央値を取るための試行回数。既定 3。 */
  repeats?: number;
}

/** 測定結果——助け自身の歯や、呼び出し側の追加の検算に使う。 */
export interface GrowthMeasurement {
  /** `t(n)` の中央値（ms）。 */
  tSmallMs: number;
  /** `t(n*factor)` の中央値（ms）。 */
  tLargeMs: number;
  /** `tLargeMs / max(tSmallMs, floorMs)`。 */
  ratio: number;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (upper === undefined) throw new Error('median: 空の配列');
  return sorted.length % 2 === 0 && lower !== undefined ? (lower + upper) / 2 : upper;
}

function measureMedianMs<TInput>(
  run: (input: TInput) => unknown,
  input: TInput,
  repeats: number,
): number {
  const samples: number[] = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    run(input);
    samples.push(performance.now() - start);
  }
  return median(samples);
}

/**
 * `run(makeInput(n))` と `run(makeInput(n * factor))` を測り、伸びの比が
 * `maxRatio` 未満（かつ `t(n*factor)` が `hardCapMs` 未満）であることを
 * `expect` する。呼び出し側は、いまの固定入力の大きさ（繰り返しの回数）が
 * `n * factor` と同じになるよう `n` を選ぶこと。
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
  const { n, factor = 4, maxRatio = 10, hardCapMs = 2000, floorMs = 1, repeats = 3 } = options;

  // JIT の温め——最初の1回は捨てる（`n` の入力で1回。大きいほうの入力は
  // 測定そのものに任せる。ここで測りたいのは「温まった後」の伸び方である）。
  run(makeInput(n));

  const small = makeInput(n);
  const large = makeInput(n * factor);
  const tSmallMs = measureMedianMs(run, small, repeats);
  const tLargeMs = measureMedianMs(run, large, repeats);
  const ratio = tLargeMs / Math.max(tSmallMs, floorMs);

  const detail =
    `t(${n})=${tSmallMs.toFixed(2)}ms, t(${n * factor})=${tLargeMs.toFixed(2)}ms, ` +
    `ratio=${ratio.toFixed(2)}（n=${n}, factor=${factor}, maxRatio=${maxRatio}, hardCapMs=${hardCapMs}, repeats=${repeats}）`;

  expect(tLargeMs, `固まり・指数的な後戻りの疑い —— hardCapMs を超えた。${detail}`).toBeLessThan(
    hardCapMs,
  );
  expect(ratio, `伸びの比が大きすぎる —— 2乗以上の後戻りの疑い。${detail}`).toBeLessThan(maxRatio);

  return { tSmallMs, tLargeMs, ratio };
}

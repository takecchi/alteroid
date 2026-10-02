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
   * 測定ラウンドの最大回数（#2576）。比が `maxRatio` を超えている間だけ重ね、
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
  /** 実際に測った小さいほうの入力の大きさ（倍にした後）。 */
  n: number;
  /** `t(n)` の最小値（ms）。 */
  tSmallMs: number;
  /** `t(n*factor)` の最小値（ms）。 */
  tLargeMs: number;
  /** `tLargeMs / max(tSmallMs, floorMs)`。 */
  ratio: number;
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
    rounds = 3,
    warmups = 3,
    maxScale = factor >= 4 ? 16 : 1,
    now = () => performance.now(),
  } = options;

  // JIT の温め——温まる前の最初の数回は捨てる（ここで測りたいのは「温まった後」の伸び方である）。
  // **n を倍にするかどうかも、温まった後の値で決める**（#2576）。以前は最初の2回（まだ遅い）で
  // 決めていたので、混んだ器では「5ms に届いている」と誤読して倍にせず、1〜2ms の分母で比を
  // 取ることになった（CI run 36798057082: t(500)=1.79ms, t(2000)=18.35ms, 比 10.23）。
  let tSmallMs = Infinity;
  let tLargeMs = Infinity;
  let ratio = Number.POSITIVE_INFINITY;
  const timeCapped = makeTimer(run, now, hardCapMs);
  // hardCapMs で打ち切られたら（#2579）、固まりの assertion として落とす。`run` の他の例外はそのまま伝わる。
  const timeOnce = (input: TInput, phase: string, size: number): number => {
    try {
      return timeCapped(input, phase, size);
    } catch (error) {
      if (!(error instanceof HungError)) throw error;
      return assert.fail(
        `固まり・指数的な後戻りの疑い —— hardCapMs を超えた。${phase}の入力 n=${size} の1回が ` +
          `hardCapMs=${hardCapMs}ms で打ち切られた（node:vm の timeout で割り込み、終わるのを待たなかった）。` +
          (Number.isFinite(tSmallMs)
            ? `それまでの最小: t(small)=${tSmallMs.toFixed(2)}ms, t(large)=${tLargeMs.toFixed(2)}ms。`
            : 'まだ最小を測り終えていない。') +
          `n=${n}（出発点 ${options.n}）, factor=${factor}, maxRatio=${maxRatio}`,
      );
    }
  };
  const warmedMs = (input: TInput, size: number): number => {
    let min = Infinity;
    for (let i = 0; i < warmups; i += 1) min = Math.min(min, timeOnce(input, '温め', size));
    return min;
  };
  let n = options.n;
  let small = makeInput(n);
  let tWarm = warmedMs(small, n);
  // t(n) が小さすぎると、分母が器の混み具合でぶれる。届くまで n を倍にする。
  while (tWarm < minSmallMs && n * 2 <= options.n * maxScale) {
    n *= 2;
    small = makeInput(n);
    tWarm = warmedMs(small, n);
  }
  const large = makeInput(n * factor);

  // **比は、全ラウンドを通した「小さいほうの最小時間」と「大きいほうの最小時間」で取る**（#2576）。
  // 器の混みは時間を足すだけで引かないので、最小時間は測るほど真の値へ単調に近づく。
  // ラウンドを重ねるのは、比が `maxRatio` を超えている間だけ（最大 `rounds` 回）。
  // **ラウンドごとの比の最小を採ってはいけない**——小さいほうだけに混みが乗ったラウンドが1つ
  // あると分母が膨らみ、2乗（理論値 factor²）でも比が閾値を下回って通る（最初の版が CI の
  // 陰性対照 `\s+$` で2乗を通した）。最小時間どうしの比なら、混みはどちらの側でも
  // 「足されるだけ」なので、2乗の比は理論値より下がらない。
  const roundLog: string[] = [];
  let hung = false;
  for (let round = 0; round < rounds && !hung; round += 1) {
    let roundSmallMs = Infinity;
    let roundLargeMs = Infinity;
    for (let i = 0; i < repeats; i += 1) {
      const tSmall = timeOnce(small, '小さいほう', n);
      roundSmallMs = Math.min(roundSmallMs, tSmall);
      tSmallMs = Math.min(tSmallMs, tSmall);
      const tLarge = timeOnce(large, '大きいほう', n * factor);
      roundLargeMs = Math.min(roundLargeMs, tLarge);
      tLargeMs = Math.min(tLargeMs, tLarge);
      // 大きいほうが1回でも上限を超えたら、残りは測らない（最小値も上限を超えているとは
      // 限らないので、超えた1回の値で落とす）。
      if (tLarge >= hardCapMs) {
        tLargeMs = tLarge;
        hung = true;
        break;
      }
    }
    ratio = tLargeMs / Math.max(tSmallMs, floorMs);
    roundLog.push(
      `#${round + 1}: t(small)最小=${roundSmallMs.toFixed(2)}ms, t(large)最小=${roundLargeMs.toFixed(2)}ms, ` +
        `累積の比=${ratio.toFixed(2)}`,
    );
    if (hung || ratio < maxRatio) break;
  }

  const detail =
    `t(${n})=${tSmallMs.toFixed(2)}ms, t(${n * factor})=${tLargeMs.toFixed(2)}ms, ` +
    `ratio=${ratio.toFixed(2)}（ラウンドごと [${roundLog.join(' | ')}]。` +
    `n=${n}（出発点 ${options.n}）, factor=${factor}, maxRatio=${maxRatio}, ` +
    `hardCapMs=${hardCapMs}, repeats=${repeats}, rounds=${rounds}, 最小値）`;

  expect(tLargeMs, `固まり・指数的な後戻りの疑い —— hardCapMs を超えた。${detail}`).toBeLessThan(
    hardCapMs,
  );
  expect(ratio, `伸びの比が大きすぎる —— 2乗以上の後戻りの疑い。${detail}`).toBeLessThan(maxRatio);

  return { n, tSmallMs, tLargeMs, ratio };
}

import { describe, expect, it } from 'vitest';

import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * `expectNotSuperlinear`（issue #2187）自身の歯。
 *
 * **測るのは「線形の関数は通り、2乗の関数は傾きで落ちる」ことそのもの。**
 * `n` に対して `n²` に比例する仕事を対照に置き、傾き（既定 factor=16 の5点で、2乗は全区間 2）
 * が既定の `maxSlope`（1.5）を超えて落ちることを確かめる——**対照が落ちなければ、
 * この助け自体が「弱い歯」である。**
 *
 * **時計は偽物を渡す（#2240 / #2243 と同じ方針）。** 実時間（`performance.now()`）で
 * 測っていたころは、CI の混みで「線形が比 9.70 で落ちる」「2乗が throw しない」といった
 * 揺れが4 run に出た。ここで確かめたいのは助けの算術（最小値の取り方・n の倍し方・
 * 比の判定・文言）であって器の速さではない。偽の時計では、仕事の長さは仕事量に比例して
 * ちょうど決まる（線形は `n / 1e6` ms、2乗は `n² / 1e6` ms）ので、「線形なら必ず通る」
 * 「2乗なら必ず落ちる」は算術で確定する。
 *
 * 助けが本物の `performance.now()` でも動くことは、最後の smoke 1本だけが見る
 * （閾値を無効にして、値が有限の正の数であることだけを見る。比の閾値は偽の時計の側で測る）。
 */

/** 偽の時計。`work` の各関数が呼ばれるたびに、仕事量に応じて `clock` を進める。 */
function makeFakeClock(): { now: () => number; advance: (ms: number) => void } {
  let clock = 0;
  return {
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** 単純な線形の仕事（O(n)）。実時間の smoke でだけ使う。 */
function linearWork(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += i ^ (i << 1);
  return sum;
}

const identity = (n: number): number => n;

/** 線形の仕事を偽の時計で表す: n あたり `msPerUnit` ms。 */
function linearOn(clock: ReturnType<typeof makeFakeClock>, msPerUnit: number) {
  return (n: number): void => clock.advance(n * msPerUnit);
}

/** 2乗の仕事を偽の時計で表す: n² あたり 1e-6 ms。 */
function quadraticOn(clock: ReturnType<typeof makeFakeClock>) {
  return (n: number): void => clock.advance((n * n) / 1_000_000);
}

/** 仕事量 `units(n)`（偽の時計で ms）を、呼ばれるたびに時計へ足す関数。 */
function workOn(clock: ReturnType<typeof makeFakeClock>, units: (n: number) => number) {
  return (n: number): void => clock.advance(units(n));
}

/**
 * 線形の仕事に、`stepAt` 以上の大きさでだけ時間が `stepFactor` 倍に跳ねる段差を入れたもの（#3017）。
 * キャッシュや GC の段差の模型。**実時間では作らない**（ぶれる）——偽の時計へ足す仕事量を、
 * 大きさで切り替えて決定的に作る（`stepAt` 以上では1単位あたりの仕事を `stepFactor` 倍にする）。
 */
function steppedLinearOn(
  clock: ReturnType<typeof makeFakeClock>,
  msPerUnit: number,
  stepAt: number,
  stepFactor: number,
) {
  return workOn(clock, (n) => n * msPerUnit * (n >= stepAt ? stepFactor : 1));
}

/**
 * 下の偽の時計の歯は、特に断らない限り factor=16（5 点・傾き 4 つ）で測る。既定（8）の形は、先頭の1本が見る。
 */
const expectFive = <TInput>(
  run: (input: TInput) => unknown,
  makeInput: (n: number) => TInput,
  options: Parameters<typeof expectNotSuperlinear>[2],
): ReturnType<typeof expectNotSuperlinear> =>
  expectNotSuperlinear(run, makeInput, { factor: 16, ...options });

describe('expectNotSuperlinear', () => {
  it('既定は factor=8（n, 2n, 4n, 8n の4点・傾き3つ）', () => {
    const clock = makeFakeClock();
    const result = expectNotSuperlinear(linearOn(clock, 1e-6), identity, {
      n: 5_000_000,
      now: clock.now,
    });
    expect(result.sizes).toEqual([5_000_000, 10_000_000, 20_000_000, 40_000_000]);
    expect(result.slopes).toHaveLength(3);
    expect(result.medianSlope).toBeCloseTo(1, 9);
  });

  it('線形の関数は通り、傾きは各区間ちょうど 1、点は n, 2n, 4n, 8n, 16n になる', () => {
    const clock = makeFakeClock();
    // n=5,000,000 で 5ms（minSmallMs 既定 5 に届くので倍にならない）。点は 5, 10, 20, 40, 80ms。
    const result = expectFive(linearOn(clock, 1e-6), identity, {
      n: 5_000_000,
      now: clock.now,
    });
    expect(result.n).toBe(5_000_000);
    expect(result.sizes).toEqual([5_000_000, 10_000_000, 20_000_000, 40_000_000, 80_000_000]);
    expect(result.timesMs.map((t) => Math.round(t * 1e6) / 1e6)).toEqual([5, 10, 20, 40, 80]);
    for (const slope of result.slopes) expect(slope).toBeCloseTo(1, 9);
    expect(result.slopes).toHaveLength(4);
    expect(result.medianSlope).toBeCloseTo(1, 9);
    expect(result.tSmallMs).toBeCloseTo(5, 9);
    expect(result.tLargeMs).toBeCloseTo(80, 9);
    expect(result.ratio).toBeCloseTo(16, 9);
  });

  it('n log n の関数も通る（傾きは約 1.1）', () => {
    const clock = makeFakeClock();
    const result = expectFive(
      workOn(clock, (n) => (n * Math.log2(n)) / 4e6),
      identity,
      { n: 200_000, now: clock.now },
    );
    expect(result.medianSlope).toBeGreaterThan(1);
    expect(result.medianSlope).toBeLessThan(1.15);
  });

  it('2乗の関数（n² に比例する仕事）は落ちる。傾きは各区間 2', () => {
    const clock = makeFakeClock();
    let error: unknown;
    try {
      expectFive(quadraticOn(clock), identity, {
        n: 2000,
        minSmallMs: 0,
        now: clock.now,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // 伸びの比の文言のまま落ち（既存の使い手の歯が `2乗以上の後戻り` に頼っている）、
    // hardCapMs（2000ms）の側ではない。n=2000 の2乗は 4ms。点は 2000, 4000, 8000, 16000, 32000 で
    // 4, 16, 64, 256, 1024ms、傾きは 2, 2, 2, 2。
    expect(message).toMatch(/伸びの比が大きすぎる —— 2乗以上の後戻り/);
    expect(message).not.toMatch(/hardCapMs を超えた/);
    expect(message).toMatch(
      /t\(2000\)=4\.00ms, t\(4000\)=16\.00ms, t\(8000\)=64\.00ms, t\(16000\)=256\.00ms, t\(32000\)=1024\.00ms/,
    );
    expect(message).toMatch(
      /2000→4000: 2\.00, 4000→8000: 2\.00, 8000→16000: 2\.00, 16000→32000: 2\.00/,
    );
    expect(message).toMatch(/中央値=2\.00/);
    expect(message).toMatch(/出発点 2000/);
  });

  it('線形に1か所だけ段差（ある大きさ以上で時間が 1.7 倍）を入れても通る。段差の位置はどこでもよい（#3017）', () => {
    // 点は 5e6, 1e7, 2e7, 4e7, 8e7。段差は1つの区間の傾き log2(2 * 1.7) = 1.77 だけを押し上げ、
    // 残りの3つは 1 のまま ⟹ 中央値は 1。2点の比（最大 / 最小）で、小さいほうの 4 倍を測る判定でも、
    // 段差が間に入ると 4 * 1.7 = 6.8 になり、実測の揺れと重なれば閾値（10）を踏む。
    for (const stepAt of [10_000_000, 20_000_000, 40_000_000, 80_000_000]) {
      const clock = makeFakeClock();
      const result = expectFive(steppedLinearOn(clock, 1e-6, stepAt, 1.7), identity, {
        n: 5_000_000,
        now: clock.now,
      });
      const sorted = [...result.slopes].sort((a, b) => a - b);
      expect(sorted[0]).toBeCloseTo(1, 9);
      expect(sorted[1]).toBeCloseTo(1, 9);
      expect(sorted[2]).toBeCloseTo(1, 9);
      expect(sorted[3]).toBeCloseTo(Math.log2(2 * 1.7), 9);
      expect(result.medianSlope).toBeCloseTo(1, 9);
    }
  });

  it('#3017 の形（段差で 6.8 倍・傾き約 2.8）でも、線形は通る', () => {
    const clock = makeFakeClock();
    const result = expectFive(steppedLinearOn(clock, 1e-6, 20_000_000, 3.4), identity, {
      n: 5_000_000,
      now: clock.now,
    });
    expect(Math.max(...result.slopes)).toBeCloseTo(Math.log2(2 * 3.4), 9);
    expect(result.medianSlope).toBeCloseTo(1, 9);
  });

  it('段差つきの2乗は、段差があっても落ちる（段差が陰性対照を隠さない）', () => {
    const clock = makeFakeClock();
    expect(() =>
      expectFive(
        workOn(clock, (n) => ((n * n) / 1_000_000) * (n >= 8000 ? 0.6 : 1)),
        identity,
        { n: 2000, minSmallMs: 0, now: clock.now },
      ),
    ).toThrow(/伸びの比が大きすぎる/);
  });

  it('3乗の関数も落ちる', () => {
    const clock = makeFakeClock();
    expect(() =>
      expectFive(
        workOn(clock, (n) => (n * n * n) / 1e9),
        identity,
        { n: 1000, minSmallMs: 0, factor: 8, now: clock.now },
      ),
    ).toThrow(/伸びの比が大きすぎる/);
  });

  it('maxSlope は使い手が動かせる（傾き 2 の2乗も、maxSlope=2.5 なら通る）', () => {
    const clock = makeFakeClock();
    const result = expectFive(quadraticOn(clock), identity, {
      n: 2000,
      minSmallMs: 0,
      maxSlope: 2.5,
      now: clock.now,
    });
    expect(result.medianSlope).toBeCloseTo(2, 9);
  });

  it('factor は最大の点の倍率（2 の冪）。既定 16 は5点、factor=4 なら3点・傾き2つ、2の冪でなければ投げる', () => {
    const clock = makeFakeClock();
    const result = expectFive(linearOn(clock, 1e-6), identity, {
      n: 5_000_000,
      factor: 4,
      now: clock.now,
    });
    expect(result.sizes).toEqual([5_000_000, 10_000_000, 20_000_000]);
    expect(result.slopes).toHaveLength(2);
    expect(() =>
      expectFive(linearOn(clock, 1e-6), identity, { n: 10, factor: 6, now: clock.now }),
    ).toThrow(RangeError);
  });

  it('固まり・指数的な後戻り（hardCapMs 超過）は、比とは別の文言で落ちる', () => {
    const clock = makeFakeClock();
    // n が大きいときだけ、傾きの判定より先に hardCapMs 自体を超える待ち（50ms）を作る。
    const hang = (n: number): void => {
      if (n > 100) clock.advance(50);
    };
    const run = (): unknown =>
      expectFive(hang, identity, {
        n: 50,
        hardCapMs: 20,
        minSmallMs: 0,
        now: clock.now,
      });
    expect(run).toThrow(/hardCapMs を超えた/);
    expect(run).not.toThrow(/伸びの比が大きすぎる/);
  });

  it('hardCapMs は最大の点だけでなく、どの点でも効く', () => {
    const clock = makeFakeClock();
    // 点は 50, 100, 200, 400。200 の点だけが 50ms かかる（400 は速い）。
    const run = (): unknown =>
      expectFive(
        (n: number) => {
          if (n === 200) clock.advance(50);
        },
        identity,
        { n: 50, hardCapMs: 20, minSmallMs: 0, now: clock.now },
      );
    expect(run).toThrow(/hardCapMs を超えた/);
  });

  it('壁時計が一様に遅くなっても（線形の関数へ n 比例の追加の待ちを足しても）傾きは保たれる', () => {
    // 本物の CI 混雑は再現できないので、代わりに「1単位あたりのコストが一様に底上げされた」
    // 状態を、線形の仕事へ n に比例する追加の待ちを足す形で模す——全体が遅くなっても、
    // 追加した分もやはり n に比例するので、傾きそのものは動かないはずである。
    const clockA = makeFakeClock();
    const withoutDelay = expectFive(linearOn(clockA, 1e-6), identity, {
      n: 5_000_000,
      now: clockA.now,
    });
    const clockB = makeFakeClock();
    const withDelay = expectFive(
      (n: number) => {
        clockB.advance(n * 1.5e-6); // 追加の待ち（n 比例）
        clockB.advance(n * 1e-6); // もとの仕事
      },
      identity,
      { n: 5_000_000, now: clockB.now },
    );

    // 底上げは実際に乗っている（時間は 2.5 倍）が、傾きはどちらも 1 のまま。
    expect(withDelay.tSmallMs).toBeCloseTo(withoutDelay.tSmallMs * 2.5, 9);
    expect(withoutDelay.medianSlope).toBeCloseTo(1, 9);
    expect(withDelay.medianSlope).toBeCloseTo(1, 9);
  });

  it('落ちたときの文に、各点の時間と各区間の傾きが生で載る', () => {
    const clock = makeFakeClock();
    let error: unknown;
    try {
      expectFive(quadraticOn(clock), identity, { n: 2000, now: clock.now });
    } catch (e) {
      error = e;
    }
    // 落ちなかったときは error が undefined のまま——ここで落とす（try の中で throw すると
    // catch に拾われて別の文言の検査になる。#2222）。
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/t\(4000\)=16\.00ms/);
    expect(message).toMatch(/t\(32000\)=1024\.00ms/);
    expect(message).toMatch(/区間ごとの傾き=\[4000→8000: 2\.00/);
    expect(message).toMatch(/maxSlope=1\.5/);
  });

  it('t(n) が小さすぎると n を倍にする（分母が器の揺れに埋もれないように）', () => {
    const clock = makeFakeClock();
    // n=1000 で 0.1ms。5ms（minSmallMs 既定）に届くまで倍にする: 0.1 * 2^6 = 6.4ms ⟹ n=64000。
    const result = expectFive(linearOn(clock, 1e-4), identity, {
      n: 1000,
      maxScale: 1024,
      now: clock.now,
    });
    expect(result.n).toBe(64_000);
  });

  it('n の倍加は maxScale で止まる（届かない仕事で無限に倍にしない）', () => {
    const clock = makeFakeClock();
    // n=1000 で 0.001ms。maxScale=1024 まで倍にしても 5ms に届かない ⟹ n=1000*1024 で止まる。
    const result = expectFive(linearOn(clock, 1e-6), identity, {
      n: 1000,
      maxScale: 1024,
      now: clock.now,
    });
    expect(result.n).toBe(1000 * 1024);
  });

  it('factor が 4 未満（指数を見る歯）なら、既定では n を倍にしない。点は2つ・傾きは1つ', () => {
    const clock = makeFakeClock();
    // t(n)=0.1ms は minSmallMs(5) に届かないが、factor=2 の既定 maxScale=1 で倍にしない。
    const result = expectFive(linearOn(clock, 1e-4), identity, {
      n: 1000,
      factor: 2,
      now: clock.now,
    });
    expect(result.n).toBe(1000);
    expect(result.sizes).toEqual([1000, 2000]);
    expect(result.slopes).toHaveLength(1);
  });

  it('最大の点の測定の何回かに混みの波が乗っても、最小値を取るので線形は落ちない（#2214 の揺れ）', () => {
    // 全部の点を小さいほうから順に1周ずつ測る。最大の点の最初の3回にだけ 30ms の待ちを足す
    // （器が混んだ波が最大の点にだけ乗った状態を模す）。中央値（時間の）なら跳ねるが、最小値は動かない。
    //
    // 時計は偽物を渡す（#2240）。偽の時計では、仕事の長さは n / 1,000,000 ms ちょうど
    // （最小の点 5ms・最大の点 80ms）で、波の乗った回だけ 30ms 足す。
    let clock = 0;
    let largeCalls = 0;
    const result = expectFive(
      (n: number) => {
        clock += n / 1_000_000;
        if (n >= 80_000_000) {
          largeCalls += 1;
          if (largeCalls <= 3) clock += 30;
        }
      },
      identity,
      { n: 5_000_000, minSmallMs: 0, now: () => clock },
    );
    expect(largeCalls).toBe(5);
    expect(result.tSmallMs).toBe(5);
    expect(result.tLargeMs).toBe(80);
    expect(result.medianSlope).toBe(1);
  });

  it('最大の点が丸ごと混んでも、中央値は動かず、線形は1ラウンドで通る（外れ1つに引きずられない）', () => {
    // 最大の点の全5回に 100ms が乗る（最小値でも 180ms）。傾きは 1, 1, 1, log2(180 / 40) = 2.17 で、中央値は 1。
    // 2点の比（5 → 180 で 36 倍）なら、これで落ちていた。
    const clock = makeFakeClock();
    let largeCalls = 0;
    const result = expectFive(
      (n: number) => {
        clock.advance(n / 1_000_000);
        if (n >= 80_000_000) {
          largeCalls += 1;
          clock.advance(100);
        }
      },
      identity,
      { n: 5_000_000, minSmallMs: 0, now: clock.now },
    );
    expect(largeCalls).toBe(5);
    expect(result.tLargeMs).toBe(180);
    expect(result.slopes[3]).toBeCloseTo(Math.log2(180 / 40), 9);
    expect(result.medianSlope).toBe(1);
  });

  it('温めの最初の数回が遅くても、n を倍にする判定は温まった後の値で行う（#2576）', () => {
    // 混んだ器では、最初の2回（JIT が温まる前）が 10ms かかり、5ms（minSmallMs）に届いて見える。
    // 以前は最初の2回で倍にするかを決めていたので、倍にせず 0.1ms の分母で比を取った。
    // 偽の時計で、最初の2回だけ 10ms 足す。温めの3回目は 0.1ms ⟹ 5ms に届くまで倍にする。
    const clock = makeFakeClock();
    let calls = 0;
    const result = expectFive(
      (n: number) => {
        calls += 1;
        clock.advance(n * 1e-4);
        if (calls <= 2) clock.advance(10);
      },
      identity,
      { n: 1000, maxScale: 1024, now: clock.now },
    );
    expect(result.n).toBe(64_000);
  });

  /**
   * 傾きの中央値まで動く混み。1ラウンド目の全5回だけ、仕事が 2乗（`(n / 1e6)²` ms の追加）になる。
   * factor=8 の点は 5e6, 1e7, 2e7, 4e7 で、1ラウンド目の時間は 30, 110, 420, 1640ms、傾きは約 1.9 〜 2.0。
   * 2ラウンド目以降は静か（線形で 5, 10, 20, 40ms）。
   */
  function crowdedRound1(clock: ReturnType<typeof makeFakeClock>, counters: Map<number, number>) {
    return (n: number): void => {
      clock.advance(n / 1_000_000);
      const calls = (counters.get(n) ?? 0) + 1;
      counters.set(n, calls);
      if (calls <= 5) clock.advance((n / 1_000_000) ** 2);
    };
  }

  it('1ラウンドが丸ごと混んで中央値まで動いても、次のラウンドが静かなら線形は通る。傾きは全ラウンドの最小時間で取る（#2576）', () => {
    const clock = makeFakeClock();
    const counters = new Map<number, number>();
    const result = expectFive(crowdedRound1(clock, counters), identity, {
      n: 5_000_000,
      minSmallMs: 0,
      factor: 8,
      now: clock.now,
    });
    expect(counters.get(40_000_000)).toBe(10); // 1ラウンド目で落ちず、2ラウンド目で通って打ち切る
    expect(result.medianSlope).toBeCloseTo(1, 9);
  });

  it('rounds=1 なら、同じ波で従来どおり1回で落ちる（ラウンドが効いていることの対照）', () => {
    const clock = makeFakeClock();
    const counters = new Map<number, number>();
    expect(() =>
      expectFive(crowdedRound1(clock, counters), identity, {
        n: 5_000_000,
        minSmallMs: 0,
        factor: 8,
        rounds: 1,
        now: clock.now,
      }),
    ).toThrow(/伸びの比が大きすぎる/);
  });

  it('2乗は、どのラウンドも傾きが大きいままなので、ラウンドを重ねても落ちる（閾値は動いていない）', () => {
    const clock = makeFakeClock();
    let error: unknown;
    try {
      expectFive(quadraticOn(clock), identity, {
        n: 2000,
        minSmallMs: 0,
        now: clock.now,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /累積の傾きの中央値=2\.00.*累積の傾きの中央値=2\.00.*累積の傾きの中央値=2\.00/,
    );
  });

  it('最小の点だけに混みが乗ったラウンドが混じっても、2乗は落ちる（ラウンドごとの最小なら通ってしまう筋書き）', () => {
    // n=2000 の2乗は 4ms（点は 4, 16, 64, 256, 1024ms）。最小の点の 9 回目以降（2・3ラウンド目）にだけ
    // 100ms の混みが乗る。最小時間どうしなら最小の点の最小は 4ms のままで、傾きは 2 のまま。
    const clock = makeFakeClock();
    let smallCalls = 0;
    let error: unknown;
    try {
      expectFive(
        (n: number) => {
          clock.advance((n * n) / 1_000_000);
          if (n === 2000) {
            smallCalls += 1;
            if (smallCalls >= 9) clock.advance(100);
          }
        },
        identity,
        { n: 2000, minSmallMs: 0, now: clock.now },
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/伸びの比が大きすぎる/);
    expect((error as Error).message).toMatch(/中央値=2\.00/);
  });

  it('smoke: 既定の時計（performance.now）でも例外なく動き、測った値は有限の正の数になる', () => {
    // 実時間で動くことだけを見る。傾きの閾値・hardCapMs は無効にしてある（Infinity）ので、
    // 器がどれだけ混んでも揺れない。閾値の判定は上の偽の時計のテストが持つ。
    const result = expectFive(linearWork, identity, {
      n: 200_000,
      minSmallMs: 0,
      maxSlope: Number.POSITIVE_INFINITY,
      hardCapMs: Number.POSITIVE_INFINITY,
    });
    expect(result.n).toBe(200_000);
    expect(result.timesMs).toHaveLength(5);
    expect(result.slopes.every((x) => Number.isFinite(x))).toBe(true);
    expect(Number.isFinite(result.medianSlope)).toBe(true);
    expect(result.tSmallMs).toBeGreaterThan(0);
    expect(result.tLargeMs).toBeGreaterThan(0);
    expect(result.ratio).toBeGreaterThan(0);
  });
});

/**
 * **陰性対照（常設・実時間・本物の正規表現）**（#2576）。上の偽の時計の歯は助けの算術を
 * 確かめるが、「本物の後戻りを、本物の `RegExp` と本物の時計で捕まえる」ことは確かめない。
 * ここでは後戻りが爆発する正規表現を与え、助けが落とすことを確かめる。**この歯が落ちなく
 * なったら、助けが弱くなっている**（ラウンドの最小値が揺れ以外も隠している、など）。
 *
 * 余裕の見積もり（2026-10-02 手元の実測）: `(a+)+$` は n=12 で 0.4ms 未満、n=24 で約 200ms
 * （n=11→22 で約 50ms、比は数十〜数百倍。理論値は 2^11 = 2048 倍）。`\s+$` を空白の列＋`x` に当てる形は2乗で、n=2000 が
 * 約 1.5ms、n=32000 が約 320ms（n を16倍で時間は約 200 倍）。どちらも閾値 10 には桁で余裕がある。
 * 線形のほうの対照（落ちないこと）は、約 65 箇所の本物の歯が毎回測っている。
 *
 * **2乗の n は 7000（#2649）**。n=4000 では CI run 37042693462 で t(4000)=26.17ms, t(16000)=223.76ms,
 * 比 8.55 となり、2乗を通した（手元の t(4000) は約 14ms なので、小さいほうの3回すべてに十数 ms の
 * 混みが足された形）。比が閾値を下回ったラウンドで助けは止まるので、1ラウンド目の小さいほうに
 * 足された混みがそのまま比を下げる。分母を太くして、同じ混みでは比が 10 を割らないようにする。
 * 手元（2026-10-03）で1ラウンド目の小さいほう3回に busy-wait を足して測ると:
 * - n=4000 は +14ms で 10 回中 9 回通した（1ラウンド目の比 8.28〜9.36）
 * - n=6000 は +14ms で全部落とし（比 10.9〜12.6）、+20ms で 8 回中 3 回通した
 * - n=7000 は +26ms まで全部落とし（1ラウンド目の比 10.07〜11.87）、+32ms で 6 回中 5 回通した
 * 足さなければ n=7000 は t(28000) 約 760〜960ms、比 14.5〜18.2。大きいほうは hardCapMs（2000ms）に
 * 2倍の余裕を残す（越えても `hardCapMs を超えた` で落ちるので、対照としては落ちる側に倒れる）。
 *
 * **2乗の n は 7000 → 10000（#2985）**。n=7000 でも CI run 37294948963 で t(7000)=89.74ms,
 * t(28000)=890.33ms, 比 9.92 となり、2乗を通した。大きいほうは手元の範囲（760〜960ms）の内で、
 * 小さいほうだけが手元の約 50ms から約 90ms へ上がっている。器全体が一様に遅いのではなく、小さい
 * ほうの3回すべてに約 +40ms の加算的な混みが乗った形と読める（読みであって、CI の器の中は観測していない）。
 * 2乗の理論比 16 のとき、比が 10 を割らずに耐えられる加算は小さいほうの 0.6 倍（実測の比 14.5 なら 0.45 倍）で、
 * n=7000 では 22〜30ms。今回の約 40ms はこれを越える（#2655 の表: +32ms で 1/6 と整合）。
 * 耐えられる加算は t(small) に比例するので n² で増え、n=10000 では約 46〜61ms になる（約 2 倍）。
 * 大きいほう t(40000) は手元で約 1.55〜1.96s（t(28000) の 760〜960ms の (10/7)² 倍）。遅い器では
 * hardCapMs（2000ms）を越えるが、その場合は `hardCapMs を超えた` で落ちる側に倒れる（助けは tLarge >= hardCapMs
 * で hung にして expect で落とす。vm の timeout で打ち切られた場合も同じ文言）。器が遅いほど小さいほうにも
 * 混みが乗りやすいが、そのときは比ではなく上限が落とす。比の歯が働く範囲は、ほぼ手元の速さの器に残る。
 * 1 回の測定は 1 ラウンドで約 6s（3 ラウンドまで重ねても 20s 前後）なので、`it` の timeout を 90s に広げた。
 * 助けと閾値（factor=4・maxRatio=10（当時。#3017 で factor=8・maxSlope=1.5 へ替えた）・hardCapMs=2000・repeats=3・rounds）は動かしていない。
 *
 * **助けの側（「閾値のすぐ下の帯でも測り直す」）では直さない**（#2649 で試して捨てた）。
 * `sqrt(factor * maxRatio)` 以上で止めずに重ねる版は、この形の2乗を確かに落としたが、線形の歯
 * （`bash-wait-guard-*` など 23 ファイル）を混んだ器で回すと、従来なら1ラウンド目の比 6.3〜9.3 で
 * 通っていた線形を 9 本、静かな器でも 1 本（`| bash -x の繰り返し`、1ラウンド目 6.78 → 15.19）落とした。
 * 短い小さいほうは混みを避けて測れる回があるが、長い大きいほうは避けにくいので、
 * 測り直すほど最小時間の比は上へずれる。線形を落とす向きの揺れ（#2576）を増やす。
 */
/** 投げるはずの測定。投げなかったときは、測った値を表明の文に出す（CI で値が読めるように）。 */
function expectGrowthDetected(
  run: (input: string) => unknown,
  makeInput: (n: number) => string,
  options: Parameters<typeof expectNotSuperlinear>[2],
): void {
  let measured: unknown;
  let thrown: unknown;
  try {
    measured = expectNotSuperlinear(run, makeInput, options);
  } catch (e) {
    thrown = e;
  }
  expect(
    thrown,
    `後戻りを助けが通した。測定値: ${JSON.stringify(measured)}（sizes・timesMs・slopes・medianSlope ほか）`,
  ).toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(/伸びの比が大きすぎる|hardCapMs を超えた/);
}

describe('陰性対照: 後戻りが爆発する正規表現を、助けは実時間でも落とす', () => {
  it('入れ子の量指定子 (a+)+$ ——指数的な後戻りは比で落ちる', () => {
    const exponential = /(a+)+$/;
    expectGrowthDetected(
      (input) => exponential.test(input),
      (n) => `${'a'.repeat(n)}!`,
      { n: 11, factor: 2, repeats: 2 },
    );
  }, 30_000);

  it('2乗の後戻り（空白の列＋x に \\s+$）は、factor=8・既定の maxSlope=1.5 で落ちる', () => {
    // #3017: 点は 4000, 8000, 16000, 32000（手元で約 14, 55, 220, 900ms、傾きは各区間約 2）。
    // 最大の点が hardCapMs（2000ms）に2倍の余裕を持つ大きさに選んである。
    const quadratic = /\s+$/;
    expectGrowthDetected(
      (input) => quadratic.test(input),
      (n) => `${' '.repeat(n)}x`,
      { n: 4000, factor: 8, minSmallMs: 0, repeats: 3 },
    );
  }, 90_000);
});

/**
 * **固まらずに赤で終わる（#2579）**。`run` が指数的な後戻りで戻ってこないとき、助けは
 * `hardCapMs` で `run` を打ち切って、読める assertion で落ちなければならない。以前は同期呼び出しが
 * 戻らず、`hardCapMs` も vitest の testTimeout も効かないまま CI の job 全体の時間切れまで固まった。
 * ここの正規表現は、打ち切りが無ければ**何分・何時間でも**終わらない大きさ（`(a+)+$` は n を1増やすごとに約2倍）。
 * `it` の timeout は打ち切りの総和（hardCapMs 500ms × 1回）よりずっと長い 20 秒。
 */
describe('固まりの打ち切り（node:vm の timeout、#2579）', () => {
  const exponential = /(a+)+$/;
  const runExponential = (input: string): boolean => exponential.test(input);
  const makeInput = (n: number): string => `${'a'.repeat(n)}!`;

  it('大きいほうが指数的に固まっても、hardCapMs で打ち切られ、hardCapMs の文言で落ちる', () => {
    const startedAt = Date.now();
    let error: unknown;
    try {
      // n=12 は一瞬、n*4=48 は 2^48 級で終わらない。
      expectNotSuperlinear(runExponential, makeInput, {
        n: 12,
        minSmallMs: 0,
        hardCapMs: 500,
        repeats: 2,
      });
    } catch (e) {
      error = e;
    }
    const elapsedMs = Date.now() - startedAt;
    expect(error, '固まった実装を助けが通した').toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/固まり・指数的な後戻りの疑い —— hardCapMs を超えた/);
    expect(message).toMatch(/大きいほうの入力 n=48 の1回が hardCapMs=500ms で打ち切られた/);
    expect(message).not.toMatch(/伸びの比が大きすぎる/);
    // 打ち切りは hardCapMs 付近で効く（終わらないなら、ここへ来ない）。
    expect(elapsedMs).toBeLessThan(15_000);
  }, 20_000);

  it('温めの段階で（小さいほうの入力が）固まっても、同じ文言で落ちる', () => {
    expect(() =>
      expectNotSuperlinear(runExponential, makeInput, {
        n: 60,
        minSmallMs: 0,
        hardCapMs: 500,
      }),
    ).toThrow(/hardCapMs を超えた.*温めの入力 n=60 の1回が hardCapMs=500ms で打ち切られた/);
  }, 20_000);

  it('run が投げた（打ち切りではない）例外は、そのまま伝わる', () => {
    const boom = new RangeError('run の失敗');
    let error: unknown;
    try {
      expectNotSuperlinear(
        () => {
          throw boom;
        },
        identity,
        { n: 10, hardCapMs: 500 },
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBe(boom);
  });
});

import { describe, expect, it } from 'vitest';

import { expectNotSuperlinear } from './time-growth.test-support.js';

// 時計は偽物を渡す: 実時間だと CI の混みで線形が落ちたり2乗が通ったりするため

function makeFakeClock(): { now: () => number; advance: (ms: number) => void } {
  let clock = 0;
  return {
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function linearWork(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += i ^ (i << 1);
  return sum;
}

const identity = (n: number): number => n;

function linearOn(clock: ReturnType<typeof makeFakeClock>, msPerUnit: number) {
  return (n: number): void => clock.advance(n * msPerUnit);
}

function quadraticOn(clock: ReturnType<typeof makeFakeClock>) {
  return (n: number): void => clock.advance((n * n) / 1_000_000);
}

function workOn(clock: ReturnType<typeof makeFakeClock>, units: (n: number) => number) {
  return (n: number): void => clock.advance(units(n));
}

function steppedLinearOn(
  clock: ReturnType<typeof makeFakeClock>,
  msPerUnit: number,
  stepAt: number,
  stepFactor: number,
) {
  return workOn(clock, (n) => n * msPerUnit * (n >= stepAt ? stepFactor : 1));
}

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
    const result = expectFive(linearOn(clock, 1e-6), identity, {
      n: 5_000_000,
      now: clock.now,
    });
    expect(result.n).toBe(5_000_000);
    expect(result.sizes).toEqual([5_000_000, 10_000_000, 20_000_000, 40_000_000, 80_000_000]);
    expect(result.timesMs.map((t) => Math.round(t * 1e6) / 1e6)).toEqual([5, 10, 20, 40, 80]);
    for (const slope of result.slopes) expect(slope).toBeCloseTo(1, 9);
    expect(result.slopes).toHaveLength(4);
    expect(result.slope).toBeCloseTo(1, 9);
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
    expect(result.slope).toBeGreaterThan(1);
    expect(result.slope).toBeLessThan(1.15);
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
    expect(message).toMatch(/伸びの比が大きすぎる —— 2乗以上の後戻り/);
    expect(message).not.toMatch(/hardCapMs を超えた/);
    expect(message).toMatch(
      /t\(2000\)=4\.00ms, t\(4000\)=16\.00ms, t\(8000\)=64\.00ms, t\(16000\)=256\.00ms, t\(32000\)=1024\.00ms/,
    );
    expect(message).toMatch(
      /2000→4000: 2\.00, 4000→8000: 2\.00, 8000→16000: 2\.00, 16000→32000: 2\.00/,
    );
    expect(message).toMatch(/最小二乗の傾き=2\.00/);
    expect(message).toMatch(/出発点 2000/);
  });

  const lsSlope = (times: number[]): number => {
    const ys = times.map((t) => Math.log2(t));
    const mx = (ys.length - 1) / 2;
    const my = ys.reduce((x, y) => x + y, 0) / ys.length;
    const sxy = ys.reduce((acc, y, i) => acc + (i - mx) * (y - my), 0);
    const sxx = ys.reduce((acc, _y, i) => acc + (i - mx) ** 2, 0);
    return sxy / sxx;
  };

  it('線形に1か所だけ段差（ある大きさ以上で時間が 1.7 倍）を入れても通る。段差の位置はどこでもよい（#3017）', () => {
    for (const [factor, stepAts] of [
      [8, [10_000_000, 20_000_000, 40_000_000]],
      [16, [10_000_000, 20_000_000, 40_000_000, 80_000_000]],
    ] as const) {
      for (const stepAt of stepAts) {
        const clock = makeFakeClock();
        const result = expectNotSuperlinear(steppedLinearOn(clock, 1e-6, stepAt, 1.7), identity, {
          n: 5_000_000,
          factor,
          now: clock.now,
        });
        expect(result.slope, `factor=${factor} stepAt=${stepAt}`).toBeCloseTo(
          lsSlope(result.timesMs),
          9,
        );
        expect(result.slope, `factor=${factor} stepAt=${stepAt}`).toBeGreaterThan(1);
        expect(result.slope, `factor=${factor} stepAt=${stepAt}`).toBeLessThan(1.35);
        expect(Math.max(...result.slopes)).toBeCloseTo(Math.log2(2 * 1.7), 9);
        expect(result.medianSlope).toBeCloseTo(1, 9);
      }
    }
  });

  it('#3017 の形（段差の区間で時間が 6.8 倍・区間の傾き約 2.8）の線形: 端の区間は通り、factor=8 の中央の区間は落ちる。factor=16 は全部通る', () => {
    const slopeAt = (factor: number, stepAt: number): number => {
      const clock = makeFakeClock();
      return expectNotSuperlinear(steppedLinearOn(clock, 1e-6, stepAt, 3.4), identity, {
        n: 5_000_000,
        factor,
        maxSlope: Number.POSITIVE_INFINITY,
        now: clock.now,
      }).slope;
    };
    expect(slopeAt(8, 10_000_000)).toBeCloseTo(1.53, 1);
    expect(slopeAt(8, 20_000_000)).toBeCloseTo(1.71, 1);
    expect(slopeAt(8, 40_000_000)).toBeCloseTo(1.53, 1);
    for (const stepAt of [10_000_000, 20_000_000, 40_000_000, 80_000_000]) {
      expect(slopeAt(16, stepAt)).toBeLessThan(1.6);
    }
    const clock = makeFakeClock();
    expect(() =>
      expectNotSuperlinear(steppedLinearOn(clock, 1e-6, 20_000_000, 3.4), identity, {
        n: 5_000_000,
        now: clock.now,
      }),
    ).toThrow(/伸びの比が大きすぎる/);
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
    expect(result.slope).toBeCloseTo(2, 9);
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
    const clockA = makeFakeClock();
    const withoutDelay = expectFive(linearOn(clockA, 1e-6), identity, {
      n: 5_000_000,
      now: clockA.now,
    });
    const clockB = makeFakeClock();
    const withDelay = expectFive(
      (n: number) => {
        clockB.advance(n * 1.5e-6);
        clockB.advance(n * 1e-6);
      },
      identity,
      { n: 5_000_000, now: clockB.now },
    );

    expect(withDelay.tSmallMs).toBeCloseTo(withoutDelay.tSmallMs * 2.5, 9);
    expect(withoutDelay.slope).toBeCloseTo(1, 9);
    expect(withDelay.slope).toBeCloseTo(1, 9);
  });

  it('落ちたときの文に、各点の時間と各区間の傾きが生で載る', () => {
    const clock = makeFakeClock();
    let error: unknown;
    try {
      expectFive(quadraticOn(clock), identity, { n: 2000, minSmallMs: 0, now: clock.now });
    } catch (e) {
      error = e;
    }
    // 落ちなかったときの throw は try の外に置く: try の中だと catch に拾われて別の文言の検査になるため
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/t\(2000\)=4\.00ms/);
    expect(message).toMatch(/t\(32000\)=1024\.00ms/);
    expect(message).toMatch(/区間ごとの傾き=\[2000→4000: 2\.00/);
    expect(message).toMatch(/maxSlope=1.6/);
    expect(message).toMatch(/最小二乗の傾き=2\.00/);
  });

  it('t(n) が小さすぎると n を倍にする（分母が器の揺れに埋もれないように）', () => {
    const clock = makeFakeClock();
    const result = expectFive(linearOn(clock, 1e-4), identity, {
      n: 1000,
      maxScale: 1024,
      now: clock.now,
    });
    expect(result.n).toBe(64_000);
  });

  it('n の倍加は maxScale で止まる（届かない仕事で無限に倍にしない）', () => {
    const clock = makeFakeClock();
    const result = expectFive(linearOn(clock, 1e-6), identity, {
      n: 1000,
      maxScale: 1024,
      now: clock.now,
    });
    expect(result.n).toBe(1000 * 1024);
  });

  it('factor が 4 未満（指数を見る歯）なら、既定では n を倍にしない。点は2つ・傾きは1つ', () => {
    const clock = makeFakeClock();
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
    expect(result.slope).toBeCloseTo(1, 9);
  });

  it('最大の点が丸ごと混んでも、線形は1ラウンドで通る（最小二乗の傾きは 1.6 を超えない。区間の中央値は 1 のまま）', () => {
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
    expect(result.slope).toBeLessThan(1.6);
  });

  it('温めの最初の数回が遅くても、n を倍にする判定は温まった後の値で行う（#2576）', () => {
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
    expect(counters.get(40_000_000)).toBe(10);
    expect(result.slope).toBeCloseTo(1, 9);
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
      /累積の最小二乗の傾き=2\.00.*累積の最小二乗の傾き=2\.00.*累積の最小二乗の傾き=2\.00/,
    );
  });

  it('最小の点だけに混みが乗ったラウンドが混じっても、2乗は落ちる（ラウンドごとの最小なら通ってしまう筋書き）', () => {
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
    expect((error as Error).message).toMatch(/最小二乗の傾き=2\.00/);
  });

  it('smoke: 既定の時計（performance.now）でも例外なく動き、測った値は有限の正の数になる', () => {
    const result = expectFive(linearWork, identity, {
      n: 200_000,
      minSmallMs: 0,
      maxSlope: Number.POSITIVE_INFINITY,
      hardCapMs: Number.POSITIVE_INFINITY,
    });
    expect(result.n).toBe(200_000);
    expect(result.timesMs).toHaveLength(5);
    expect(result.slopes.every((x) => Number.isFinite(x))).toBe(true);
    expect(Number.isFinite(result.slope)).toBe(true);
    expect(Number.isFinite(result.medianSlope)).toBe(true);
    expect(result.tSmallMs).toBeGreaterThan(0);
    expect(result.tLargeMs).toBeGreaterThan(0);
    expect(result.ratio).toBeGreaterThan(0);
  });
});

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

  it('2乗の後戻り（空白の列＋x に \\s+$）は、factor=8・既定の maxSlope=1.6 で落ちる', () => {
    const quadratic = /\s+$/;
    expectGrowthDetected(
      (input) => quadratic.test(input),
      (n) => `${' '.repeat(n)}x`,
      { n: 4000, factor: 8, minSmallMs: 0, repeats: 3 },
    );
  }, 90_000);
});

describe('固まりの打ち切り（node:vm の timeout、#2579）', () => {
  const exponential = /(a+)+$/;
  const runExponential = (input: string): boolean => exponential.test(input);
  const makeInput = (n: number): string => `${'a'.repeat(n)}!`;

  it('大きいほうが指数的に固まっても、hardCapMs で打ち切られ、hardCapMs の文言で落ちる', () => {
    const startedAt = Date.now();
    let error: unknown;
    try {
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

import { describe, expect, it } from 'vitest';

import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * `expectNotSuperlinear`（issue #2187）自身の歯。
 *
 * **測るのは「線形の関数は通り、2乗の関数は比で落ちる」ことそのもの。**
 * `n` に対して `n²` に比例する仕事を対照に置き、伸びの比（既定 factor=4 なら2乗は
 * 16倍）が既定の `maxRatio`（10）を超えて落ちることを確かめる——**対照が落ちなければ、
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

describe('expectNotSuperlinear', () => {
  it('線形の関数は通り、伸びの比はちょうど factor になる', () => {
    const clock = makeFakeClock();
    // n=5,000,000 で 5ms（minSmallMs 既定 5 に届くので倍にならない）、n*4 で 20ms。
    const result = expectNotSuperlinear(linearOn(clock, 1e-6), identity, {
      n: 5_000_000,
      factor: 4,
      now: clock.now,
    });
    expect(result.n).toBe(5_000_000);
    expect(result.tSmallMs).toBeCloseTo(5, 9);
    expect(result.tLargeMs).toBeCloseTo(20, 9);
    expect(result.ratio).toBeCloseTo(4, 9);
  });

  it('2乗の関数（n² に比例する仕事）は比で落ちる', () => {
    const clock = makeFakeClock();
    // maxRatio は既定の10のまま——2乗の比は16なので、hardCapMs ではなく
    // 「伸びの比が大きすぎる」の側で落ちることも合わせて確かめる。
    expect(() =>
      expectNotSuperlinear(quadraticOn(clock), identity, {
        n: 2000,
        factor: 4,
        now: clock.now,
      }),
    ).toThrow(/伸びの比が大きすぎる/);
  });

  it('固まり・指数的な後戻り（hardCapMs 超過）は、比とは別の文言で落ちる', () => {
    const clock = makeFakeClock();
    // n が大きいときだけ、比の判定より先に hardCapMs 自体を超える待ち（50ms）を作る。
    const hang = (n: number): void => {
      if (n > 100) clock.advance(50);
    };
    const run = (): unknown =>
      expectNotSuperlinear(hang, identity, {
        n: 50,
        factor: 4,
        hardCapMs: 20,
        minSmallMs: 0,
        now: clock.now,
      });
    expect(run).toThrow(/hardCapMs を超えた/);
    expect(run).not.toThrow(/伸びの比が大きすぎる/);
  });

  it('壁時計が一様に遅くなっても（線形の関数へ n 比例の追加の待ちを足しても）比は保たれる', () => {
    // 本物の CI 混雑は再現できないので、代わりに「1単位あたりのコストが一様に底上げされた」
    // 状態を、線形の仕事へ n に比例する追加の待ちを足す形で模す——全体が遅くなっても、
    // 追加した分もやはり n に比例するので、比そのものは動かないはずである。
    const clockA = makeFakeClock();
    const withoutDelay = expectNotSuperlinear(linearOn(clockA, 1e-6), identity, {
      n: 5_000_000,
      factor: 4,
      now: clockA.now,
    });
    const clockB = makeFakeClock();
    const withDelay = expectNotSuperlinear(
      (n: number) => {
        clockB.advance(n * 1.5e-6); // 追加の待ち（n 比例）
        clockB.advance(n * 1e-6); // もとの仕事
      },
      identity,
      { n: 5_000_000, factor: 4, now: clockB.now },
    );

    // 底上げは実際に乗っている（時間は 2.5 倍）が、比はどちらも 4 のまま。
    expect(withDelay.tSmallMs).toBeCloseTo(withoutDelay.tSmallMs * 2.5, 9);
    expect(withoutDelay.ratio).toBeCloseTo(4, 9);
    expect(withDelay.ratio).toBeCloseTo(4, 9);
    expect(withDelay.ratio).toBeCloseTo(withoutDelay.ratio, 9);
  });

  it('落ちたときの文に t(n) / t(n*factor) / 比が載る', () => {
    const clock = makeFakeClock();
    let error: unknown;
    try {
      expectNotSuperlinear(quadraticOn(clock), identity, {
        n: 2000,
        factor: 4,
        now: clock.now,
      });
    } catch (e) {
      error = e;
    }
    // 落ちなかったときは error が undefined のまま——ここで落とす（try の中で throw すると
    // catch に拾われて別の文言の検査になる。#2222）。
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // n=2000 の2乗は 4ms で minSmallMs(5) に届かず、1回倍にされて n=4000（16ms）。
    // 大きいほうは n=16000（256ms）、比は 16。
    expect(message).toMatch(/t\(4000\)=16\.00ms/);
    expect(message).toMatch(/t\(16000\)=256\.00ms/);
    expect(message).toMatch(/出発点 2000/);
    expect(message).toMatch(/ratio=16\.00/);
  });

  it('t(n) が小さすぎると n を倍にする（分母が器の揺れに埋もれないように）', () => {
    const clock = makeFakeClock();
    // n=1000 で 0.1ms。5ms（minSmallMs 既定）に届くまで倍にする: 0.1 * 2^6 = 6.4ms ⟹ n=64000。
    const result = expectNotSuperlinear(linearOn(clock, 1e-4), identity, {
      n: 1000,
      maxScale: 1024,
      now: clock.now,
    });
    expect(result.n).toBe(64_000);
  });

  it('n の倍加は maxScale で止まる（届かない仕事で無限に倍にしない）', () => {
    const clock = makeFakeClock();
    // n=1000 で 0.001ms。maxScale=1024 まで倍にしても 5ms に届かない ⟹ n=1000*1024 で止まる。
    const result = expectNotSuperlinear(linearOn(clock, 1e-6), identity, {
      n: 1000,
      maxScale: 1024,
      now: clock.now,
    });
    expect(result.n).toBe(1000 * 1024);
  });

  it('factor が 4 未満（指数を見る歯）なら、既定では n を倍にしない', () => {
    const clock = makeFakeClock();
    // t(n)=0.1ms は minSmallMs(5) に届かないが、factor=2 の既定 maxScale=1 で倍にしない。
    const result = expectNotSuperlinear(linearOn(clock, 1e-4), identity, {
      n: 1000,
      factor: 2,
      now: clock.now,
    });
    expect(result.n).toBe(1000);
  });

  it('大きいほうの測定の何回かに混みの波が乗っても、最小値を取るので線形は落ちない（#2214 の揺れ）', () => {
    // 小さいほうと大きいほうを交互に測る。大きいほうの最初の3回にだけ 30ms の待ちを足す
    // （器が混んだ波が大きいほうにだけ乗った状態を模す）。中央値なら比が跳ねるが、最小値は動かない。
    //
    // 時計は偽物を渡す（#2240）。実時間で測っていたころは、既定の repeats=5 のうち波の乗らない
    // 大きいほうが2回しか残らず、その2回にも CI の混みが乗って比 9.70 で落ちた。ここで確かめたいのは
    // 「波が乗った回を最小値が捨てること」という算術で、器の速さではない。
    // 偽の時計では、仕事の長さは n / 1,000,000 ms ちょうど（小さいほう 5ms・大きいほう 20ms）で、
    // 波の乗った回だけ 30ms 足す（50ms）。
    let clock = 0;
    let largeCalls = 0;
    const result = expectNotSuperlinear(
      (n: number) => {
        clock += n / 1_000_000;
        if (n >= 20_000_000) {
          largeCalls += 1;
          if (largeCalls <= 3) clock += 30;
        }
      },
      identity,
      { n: 5_000_000, minSmallMs: 0, now: () => clock },
    );
    // 波は実際に乗っている（大きいほうを5回測り、最初の3回が 50ms）。中央値なら 50 / 5 = 10 で
    // 既定の maxRatio=10 を踏む。
    expect(largeCalls).toBe(5);
    expect(result.tSmallMs).toBe(5);
    expect(result.tLargeMs).toBe(20);
    expect(result.ratio).toBe(4);
  });

  it('温めの最初の数回が遅くても、n を倍にする判定は温まった後の値で行う（#2576）', () => {
    // 混んだ器では、最初の2回（JIT が温まる前）が 10ms かかり、5ms（minSmallMs）に届いて見える。
    // 以前は最初の2回で倍にするかを決めていたので、倍にせず 0.1ms の分母で比を取った。
    // 偽の時計で、最初の2回だけ 10ms 足す。温めの3回目は 0.1ms ⟹ 5ms に届くまで倍にする。
    const clock = makeFakeClock();
    let calls = 0;
    const result = expectNotSuperlinear(
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

  it('1ラウンドが丸ごと混んでも、次のラウンドが静かなら線形は通る。比は全ラウンドの最小時間で取る（#2576）', () => {
    // CI run 36798057082 の形（比 10.23）を、偽の時計で作る。大きいほうの最初の5回（=1ラウンド目）
    // にだけ 100ms の待ちが乗る。1ラウンド目の比は (20+100)/5 = 24、2ラウンド目は 20/5 = 4。
    const clock = makeFakeClock();
    let largeCalls = 0;
    const result = expectNotSuperlinear(
      (n: number) => {
        clock.advance(n / 1_000_000);
        if (n >= 20_000_000) {
          largeCalls += 1;
          if (largeCalls <= 5) clock.advance(100);
        }
      },
      identity,
      { n: 5_000_000, minSmallMs: 0, now: clock.now },
    );
    expect(largeCalls).toBe(10); // 1ラウンド目で落ちず、2ラウンド目で通って打ち切る
    expect(result.ratio).toBe(4);
  });

  it('rounds=1 なら、同じ波で従来どおり1回で落ちる（ラウンドが効いていることの対照）', () => {
    const clock = makeFakeClock();
    let largeCalls = 0;
    const run = (): unknown =>
      expectNotSuperlinear(
        (n: number) => {
          clock.advance(n / 1_000_000);
          if (n >= 20_000_000) {
            largeCalls += 1;
            if (largeCalls <= 5) clock.advance(100);
          }
        },
        identity,
        { n: 5_000_000, minSmallMs: 0, rounds: 1, now: clock.now },
      );
    expect(run).toThrow(/伸びの比が大きすぎる/);
  });

  it('2乗は、どのラウンドも大きいままなので、ラウンドを重ねても落ちる（閾値は動いていない）', () => {
    const clock = makeFakeClock();
    let error: unknown;
    try {
      expectNotSuperlinear(quadraticOn(clock), identity, { n: 4000, now: clock.now });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/累積の比=16\.00.*累積の比=16\.00.*累積の比=16\.00/);
  });

  it('小さいほうだけに混みが乗ったラウンドが混じっても、2乗は落ちる（ラウンドごとの比の最小なら通ってしまう筋書き）', () => {
    // 最初の版（ラウンドごとの比の最小）が CI の陰性対照で2乗を通した形。n=4000 の2乗は 16ms、
    // n=16000 は 256ms（理論値 16 倍）。小さいほうの 9 回目以降（2・3ラウンド目）にだけ 100ms
    // の混みが乗る。ラウンドごとの比の最小なら 256/116 = 2.2 で通るが、最小時間どうしなら
    // 小さいほうの最小は 16ms のままで、比は 16。
    const clock = makeFakeClock();
    let smallCalls = 0;
    let error: unknown;
    try {
      expectNotSuperlinear(
        (n: number) => {
          clock.advance((n * n) / 1_000_000);
          if (n === 4000) {
            smallCalls += 1;
            if (smallCalls >= 9) clock.advance(100);
          }
        },
        identity,
        { n: 4000, minSmallMs: 0, now: clock.now },
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/伸びの比が大きすぎる/);
    expect((error as Error).message).toMatch(/ratio=16\.00/);
  });

  it('大きいほうだけに混みが乗ったラウンドが混じっても、線形は通る', () => {
    // 大きいほうの最初の7回（1ラウンド目の全部と2ラウンド目の前半）に 100ms が乗る。
    // 2ラウンド目の後半に静かな測定があるので、大きいほうの最小は 20ms、比は 4。
    const clock = makeFakeClock();
    let largeCalls = 0;
    const result = expectNotSuperlinear(
      (n: number) => {
        clock.advance(n / 1_000_000);
        if (n >= 20_000_000) {
          largeCalls += 1;
          if (largeCalls <= 7) clock.advance(100);
        }
      },
      identity,
      { n: 5_000_000, minSmallMs: 0, now: clock.now },
    );
    expect(result.ratio).toBe(4);
    expect(largeCalls).toBe(10);
  });

  it('smoke: 既定の時計（performance.now）でも例外なく動き、測った値は有限の正の数になる', () => {
    // 実時間で動くことだけを見る。比の閾値・hardCapMs は無効にしてある（Infinity）ので、
    // 器がどれだけ混んでも揺れない。閾値の判定は上の偽の時計のテストが持つ。
    const result = expectNotSuperlinear(linearWork, identity, {
      n: 200_000,
      minSmallMs: 0,
      maxRatio: Number.POSITIVE_INFINITY,
      hardCapMs: Number.POSITIVE_INFINITY,
    });
    expect(result.n).toBe(200_000);
    expect(Number.isFinite(result.tSmallMs)).toBe(true);
    expect(Number.isFinite(result.tLargeMs)).toBe(true);
    expect(Number.isFinite(result.ratio)).toBe(true);
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
    `後戻りを助けが通した。測定値: ${JSON.stringify(measured)}（n・t(small)・t(large)・ratio）`,
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

  it('2乗の後戻り（空白の列＋x に \\s+$）は、既定の factor=4・maxRatio=10 で落ちる', () => {
    const quadratic = /\s+$/;
    expectGrowthDetected(
      (input) => quadratic.test(input),
      (n) => `${' '.repeat(n)}x`,
      { n: 7000, minSmallMs: 0, repeats: 3 },
    );
  }, 60_000);
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

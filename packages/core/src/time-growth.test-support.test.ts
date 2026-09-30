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

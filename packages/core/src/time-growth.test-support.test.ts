import { describe, expect, it } from 'vitest';

import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * `expectNotSuperlinear`（issue #2187）自身の歯。
 *
 * **測るのは「線形の関数は通り、2乗の関数は比で落ちる」ことそのもの。**
 * `n` に対して `n²` 回だけ小さな仕事を回す小さな関数を対照に置き、伸びの比
 * （既定 factor=4 なら2乗は約16倍）が既定の `maxRatio`（10）を超えて落ちる
 * ことを確かめる——**対照が落ちなければ、この助け自体が「弱い歯」である。**
 *
 * 定数（`n` の大きさ）は、手元の器で実測しながら選んである
 * （`t(n)` が測定ノイズや `floorMs` の底に埋もれない大きさにすること。
 * 2026-09-29 実測: 線形は n=5,000,000 で t(n)≈3.5ms・比≈4、2乗は n=2000 で
 * t(n)≈2.7ms・比≈15〜16——どちらも安定して同じ側に落ちる）。
 */

/** 単純な線形の仕事（O(n)）。 */
function linearWork(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += i ^ (i << 1);
  return sum;
}

/** `n` に対して `n²` 回だけ小さな仕事を回す（O(n²)）。 */
function quadraticWork(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) sum += i ^ j;
  }
  return sum;
}

const identity = (n: number): number => n;

/** 忙しい待ち（意図的なビジーループ）。CI が混んだときの「一様な底上げ」を模す。 */
function busyWaitMs(ms: number): void {
  if (ms <= 0) return;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // 忙しい待ち。何もしない。
  }
}

describe('expectNotSuperlinear', () => {
  it('線形の関数は通り、伸びの比は約 factor に収まる', () => {
    const result = expectNotSuperlinear(linearWork, identity, { n: 5_000_000, factor: 4 });
    // 理論値は4だが、実測の揺れを見込んで緩い範囲で確かめる
    // （下の「2乗は約16倍」と混同しないよう、maxRatio の既定10より十分低い
    // ところに閾値を置く）。
    expect(result.ratio).toBeGreaterThan(1);
    expect(result.ratio).toBeLessThan(8);
  });

  it('2乗の関数（n に対して n² 回回す小さな関数）は比で落ちる', () => {
    // maxRatio は既定の10のまま——2乗の理論比は16なので、hardCapMs ではなく
    // 「伸びの比が大きすぎる」の側で落ちることも合わせて確かめる。
    expect(() => expectNotSuperlinear(quadraticWork, identity, { n: 2000, factor: 4 })).toThrow(
      /伸びの比が大きすぎる/,
    );
  });

  it('固まり・指数的な後戻り（hardCapMs 超過）は、比とは別の文言で落ちる', () => {
    const hang = (n: number): void => {
      // n が大きいときだけ、比の判定より先に hardCapMs 自体を超える待ちを作る。
      if (n > 100) busyWaitMs(50);
    };
    expect(() => expectNotSuperlinear(hang, identity, { n: 50, factor: 4, hardCapMs: 20 })).toThrow(
      /hardCapMs を超えた/,
    );
  });

  it('壁時計が一様に遅くなっても（線形の関数へ n 比例の追加busy-waitを足しても）比は保たれる', () => {
    // 本物の CI 混雑は手元では再現できないので、代わりに「1単位あたりの
    // コストが一様に底上げされた」状態を、線形の関数へ n に比例する
    // busy-wait を追加で足す形で模す——器が混んで全体が遅くなっても、
    // 追加した分もやはり n に比例するので、比そのものは動かないはずである。
    const withoutDelay = expectNotSuperlinear(linearWork, identity, { n: 5_000_000, factor: 4 });
    const withDelay = expectNotSuperlinear(
      (n: number) => {
        busyWaitMs(n * 0.0000015);
        return linearWork(n);
      },
      identity,
      { n: 5_000_000, factor: 4 },
    );

    // どちらも「2乗の疑い」の閾値（maxRatio 既定10）には遠く届かない。
    expect(withoutDelay.ratio).toBeLessThan(10);
    expect(withDelay.ratio).toBeLessThan(10);
    // busy-wait を足しても、比が大きく動かない（一様な底上げでは比が保たれる）。
    expect(Math.abs(withDelay.ratio - withoutDelay.ratio)).toBeLessThan(6);
  });

  it('落ちたときの文に t(n) / t(n*factor) / 比が載る', () => {
    try {
      expectNotSuperlinear(quadraticWork, identity, { n: 2000, factor: 4 });
      throw new Error('unreachable: 落ちるはず');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // n は t(n) が minSmallMs に届くまで倍にされうるので、数は決め打ちしない。
      expect(message).toMatch(/t\(\d+\)=/);
      expect(message).toMatch(/出発点 2000/);
      expect(message).toMatch(/ratio=/);
    }
  });

  it('t(n) が小さすぎると n を倍にする（分母が器の揺れに埋もれないように）', () => {
    // 出発点の n=1000 の線形の仕事は 1ms にも届かない。minSmallMs（既定 5ms）へ向けて倍にされる。
    const result = expectNotSuperlinear(linearWork, identity, { n: 1000, maxScale: 1024 });
    expect(result.n).toBeGreaterThan(1000);
    expect(result.n).toBeLessThanOrEqual(1000 * 1024);
  });

  it('factor が 4 未満（指数を見る歯）なら、既定では n を倍にしない', () => {
    const result = expectNotSuperlinear(linearWork, identity, { n: 1000, factor: 2 });
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
});

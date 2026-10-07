import { describe, expect, it } from 'vitest';

import {
  judgeBundleSize,
  SINGLE_CHUNK_MAX_BYTES,
  TOTAL_MAX_BYTES,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-web-bundle-size-core.mjs';

describe('check-web-bundle-size: judgeBundleSize', () => {
  it('どちらの予算も超えていなければ ok', () => {
    const result = judgeBundleSize([
      { path: 'a.js', bytes: 1000 },
      { path: 'b.js', bytes: 2000 },
    ]);
    expect(result.ok).toBe(true);
    expect(result.oversized).toEqual([]);
    expect(result.totalOver).toBe(false);
  });

  it('大きい順に並べる', () => {
    const result = judgeBundleSize([
      { path: 'small.js', bytes: 100 },
      { path: 'big.js', bytes: 300 },
      { path: 'mid.js', bytes: 200 },
    ]);
    expect(result.sorted.map((f: { path: string }) => f.path)).toEqual([
      'big.js',
      'mid.js',
      'small.js',
    ]);
    expect(result.maxChunk.path).toBe('big.js');
  });

  it('単一チャンクが予算を超えると oversized に載り、超過分（B と %）を持つ', () => {
    const overBy = Math.round(SINGLE_CHUNK_MAX_BYTES * 0.1);
    const bytes = SINGLE_CHUNK_MAX_BYTES + overBy;
    const result = judgeBundleSize([{ path: 'huge.js', bytes }]);
    expect(result.ok).toBe(false);
    expect(result.oversized).toEqual([
      {
        path: 'huge.js',
        bytes,
        overBytes: overBy,
        overPercent: expect.closeTo(10, 0),
      },
    ]);
  });

  it('予算ちょうどは超過ではない（境界は超えていない側）', () => {
    const result = judgeBundleSize([{ path: 'exact.js', bytes: SINGLE_CHUNK_MAX_BYTES }]);
    expect(result.ok).toBe(true);
    expect(result.oversized).toEqual([]);
  });

  it('総量が予算を超えると totalOver が true になり、個々のチャンクは oversized に載らないことがある', () => {
    // 本数は2つの予算から導く: `TOTAL_MAX_BYTES / 4` のように固定すると、総量の予算が動いたとき単一チャンクの予算を超えて前提が崩れるため。
    const files = Array.from(
      { length: Math.floor(TOTAL_MAX_BYTES / SINGLE_CHUNK_MAX_BYTES) + 1 },
      (_, i) => ({ path: `chunk-${i}.js`, bytes: SINGLE_CHUNK_MAX_BYTES }),
    );
    const result = judgeBundleSize(files);
    expect(result.ok).toBe(false);
    expect(result.totalOver).toBe(true);
    expect(result.oversized).toEqual([]);
  });

  it('#335 の実測（単一チャンク 1,198,608 B）を通すと、単一チャンク・総量の両方の予算を超える', () => {
    // 残りは単一チャンクの予算未満の3ファイルに割る: 1ファイルにまとめると、そのファイル自体も単一チャンクの予算を超えてしまうため。
    const result = judgeBundleSize([
      { path: 'commitments.js', bytes: 1_198_608 },
      { path: 'other-1.js', bytes: 242_000 },
      { path: 'other-2.js', bytes: 242_000 },
      { path: 'other-3.js', bytes: 242_545 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.oversized.map((h: { path: string }) => h.path)).toEqual(['commitments.js']);
    expect(result.totalOver).toBe(true);
    expect(result.totalBytes).toBe(1_925_153);
  });

  it('使用率（%）を計算する', () => {
    const result = judgeBundleSize([{ path: 'a.js', bytes: SINGLE_CHUNK_MAX_BYTES / 2 }]);
    expect(result.singleBudgetUsedPercent).toBeCloseTo(50, 0);
    expect(result.totalBudgetUsedPercent).toBeCloseTo(
      (SINGLE_CHUNK_MAX_BYTES / 2 / TOTAL_MAX_BYTES) * 100,
      5,
    );
  });

  // 現在の値そのものを固定する: `-core.mjs` 側だけを直して予算を黙って上げられないようにするため。
  it('⚠️ 閾値は固定してある（上げるにはここと -core.mjs の両方を直すこと）', () => {
    expect(SINGLE_CHUNK_MAX_BYTES).toBe(262_144);
    expect(TOTAL_MAX_BYTES).toBe(1_179_648);
  });
});

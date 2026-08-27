import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import {
  judgeBundleSize,
  SINGLE_CHUNK_MAX_BYTES,
  TOTAL_MAX_BYTES,
} from './check-web-bundle-size-core.mjs';

/**
 * `check-web-bundle-size` の判定ロジックの歯。
 *
 * **本物の `pnpm build` を走らせずに試す。** CLI 側（`check-web-bundle-size.mjs`）は
 * ファイル読み込みだけを持ち、判定は `check-web-bundle-size-core.mjs` に切り出して
 * あるので、ここでは合成した `{ path, bytes }` の配列で判定だけを確かめる
 * （`check-web-bundle-node-traces.test.ts` と同じ分け方・同じ理由）。
 */
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
    // 予算 + 26,214 B（予算のちょうど10%増し）にした合成入力。
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
    // 1つ1つは単一チャンクの予算未満だが、数を集めると総量の予算を超える形。
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `chunk-${i}.js`,
      bytes: Math.floor(TOTAL_MAX_BYTES / 4),
    }));
    const result = judgeBundleSize(files);
    expect(result.ok).toBe(false);
    expect(result.totalOver).toBe(true);
    expect(result.oversized).toEqual([]);
  });

  it('#335 の実測（単一チャンク 1,198,608 B）を通すと、単一チャンク・総量の両方の予算を超える', () => {
    // 実測: PR 本文・check-web-bundle-size.mjs の doc に同じ数字がある。
    // 残り（726,545 B）は単一チャンクの予算未満の3ファイルに割って、
    // 「単一チャンクの予算を超えたのは commitments.js だけ」を確かめられる形にする
    // （1ファイルにまとめると、その1ファイル自体も単一チャンクの予算を超えてしまう）。
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

  /**
   * **予算を上げるには2箇所を直す必要がある。**
   *
   * `SINGLE_CHUNK_MAX_BYTES` / `TOTAL_MAX_BYTES` は `check-web-bundle-size-core.mjs`
   * に `export const` で置いてあるので、値を変えれば diff に出る。だがそれだけでは
   * **黙って上げる**（レビューで見過ごされる・diff が大きい PR に紛れる）ことを
   * 防げない。ここで現在の値そのものを固定しておけば、`-core.mjs` 側だけを直しても
   * このテストが赤くなる ＝ 「なぜ上げたか」をこのテストのコメントと一緒に直さない
   * 限り緑にならない。
   *
   * **値を上げる正当な理由ができたら、このテストの期待値も一緒に更新すること。**
   * そのときは `check-web-bundle-size.mjs` の doc（閾値の根拠の節）も書き直すこと —
   * 実測が変わったのに根拠の文章だけ古いままだと、次に読む人が嘘の実測を信じる。
   */
  it('⚠️ 閾値は固定してある（上げるにはここと -core.mjs の両方を直すこと）', () => {
    expect(SINGLE_CHUNK_MAX_BYTES).toBe(262_144);
    expect(TOTAL_MAX_BYTES).toBe(1_048_576);
  });
});

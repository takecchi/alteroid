import { describe, expect, it } from 'vitest';

import { exactTokens, heuristicChars } from './quantity.js';

/**
 * `heuristicChars` / `exactTokens`（`quantity.ts`。#804 案2）。
 *
 * **ここで測るのは「実行時の表現が素の `number` のまま変わっていないこと」
 * だけである。** `estimateKind` を取り違えたら `tsc` が落ちる、という
 * 型そのものの主張は vitest では測れない（vitest は型を落とす）——
 * その歯は別に用意する（`quantity.ts` モジュール冒頭の doc、および
 * この変更の報告に添える `tsc --noEmit` の生出力）。ここは
 * `quantity.ts` の「読む側は1行も直さなくてよい」という主張——比較・
 * 算術・`toLocaleString()` が素の `number` と同じ値を返すこと——を
 * **数値で**確かめる。
 */
describe('heuristicChars / exactTokens — branded number は実行時にはただの number', () => {
  it('heuristicChars(value) は value そのものを返す(===で一致、包んでいない)', () => {
    expect(heuristicChars(12_345)).toBe(12_345);
    expect(heuristicChars(0)).toBe(0);
  });

  it('exactTokens(value) は value そのものを返す(===で一致、包んでいない)', () => {
    expect(exactTokens(8_000)).toBe(8_000);
    expect(exactTokens(0)).toBe(0);
  });

  it('typeof は両方とも number のまま(オブジェクトへ包んでいない)', () => {
    expect(typeof heuristicChars(1)).toBe('number');
    expect(typeof exactTokens(1)).toBe('number');
  });

  it('toLocaleString() は素の number と同じ文字列を返す', () => {
    const raw = 1_234_567;
    expect(heuristicChars(raw).toLocaleString('en-US')).toBe(raw.toLocaleString('en-US'));
    expect(exactTokens(raw).toLocaleString('en-US')).toBe(raw.toLocaleString('en-US'));
  });

  it('比較演算子(<, >, ===)は素の number と同じ結果を返す', () => {
    expect(heuristicChars(10) > heuristicChars(5)).toBe(true);
    expect(heuristicChars(5) < heuristicChars(10)).toBe(true);
    expect(heuristicChars(7) === heuristicChars(7)).toBe(true);
    // 素の number とも直接比較できる(読む側は1行も直さなくてよい、という主張)。
    expect(heuristicChars(7) === 7).toBe(true);
  });

  it('算術演算子は素の number と同じ値を返す(結果は素の number へ戻る)', () => {
    const sum: number = heuristicChars(10) + heuristicChars(5);
    expect(sum).toBe(15);
    const diff: number = exactTokens(100) - exactTokens(40);
    expect(diff).toBe(60);
  });

  it('JSON.stringify は素の number と同じ表現になる(隠れたラッパーを持たない)', () => {
    expect(JSON.stringify({ value: heuristicChars(42) })).toBe(JSON.stringify({ value: 42 }));
    expect(JSON.stringify({ value: exactTokens(42) })).toBe(JSON.stringify({ value: 42 }));
  });
});

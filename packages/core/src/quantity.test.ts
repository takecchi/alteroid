import { describe, expect, it } from 'vitest';

import { exactTokens, heuristicChars } from './quantity.js';

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

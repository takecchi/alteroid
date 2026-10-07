import { describe, expect, it } from 'vitest';

import { journalEntry, minute, said } from './fake-api.js';
import { entryChars, listWindow, trimToBudget } from './journal-window.js';

describe('文字数の予算', () => {
  it('大きさは JSON にした長さ。超えたら古い側（末尾）から手放し、最低 1 件は残す', () => {
    const entries = [
      said(3, 'あ'.repeat(100)),
      said(2, 'い'.repeat(100)),
      said(1, 'う'.repeat(100)),
    ];
    const one = entryChars(entries[0] ?? said(0));
    const fits2 = trimToBudget(entries, one * 2 + 10);
    expect(fits2.entries.map((e) => e.id)).toEqual(['e3', 'e2']);
    expect(fits2.dropped).toBe(1);
    expect(fits2.chars).toBeLessThanOrEqual(one * 2 + 10);
    expect(trimToBudget(entries, 1).entries.map((e) => e.id)).toEqual(['e3']);
    expect(trimToBudget(entries, 1_000_000).dropped).toBe(0);
  });

  it('件数ではなく文字数で締まる: 小さい行なら多く、大きい行なら少なく残る', () => {
    const small = Array.from({ length: 50 }, (_, i) =>
      journalEntry(`s${String(i)}`, 'turn_usage', minute(i)),
    );
    const large = Array.from({ length: 50 }, (_, i) => said(i, 'あ'.repeat(500)));
    const budget = 10_000;
    expect(trimToBudget(small, budget).entries.length).toBeGreaterThan(
      trimToBudget(large, budget).entries.length,
    );
  });
});

describe('可視窓', () => {
  it('全部が窓に収まるなら全部。追従中は末尾の窓', () => {
    expect(listWindow(3, 0, true, 10)).toEqual({ start: 0, end: 3 });
    expect(listWindow(100, 0, true, 10)).toEqual({ start: 90, end: 100 });
  });

  it('遡っている間は選択を窓の中ほどに置き、新着が末尾に足されても窓は動かない', () => {
    const before = listWindow(100, 30, false, 10);
    expect(before.start).toBeLessThanOrEqual(69);
    expect(before.end).toBeGreaterThan(69);
    expect(before.end - before.start).toBe(10);
    expect(listWindow(105, 35, false, 10)).toEqual(before);
  });

  it('端では窓がはみ出さない', () => {
    expect(listWindow(100, 99, false, 10)).toEqual({ start: 0, end: 10 });
    expect(listWindow(100, 0, false, 10)).toEqual({ start: 90, end: 100 });
  });
});

import { describe, expect, it } from 'vitest';

import { summarizeContextCategories } from './context-usage.js';

describe('summarizeContextCategories', () => {
  it('⭐⭐⭐ 核心の歯: free の軸は used に1トークンも混ざらず、free 側にちょうど入る', () => {
    const summary = summarizeContextCategories([
      { name: 'System prompt', tokens: 8_000, kind: 'used' },
      { name: 'Remaining window', tokens: 190_000, kind: 'free' },
    ]);

    expect(summary.used.tokens).toBe(8_000);
    expect(summary.used.count).toBe(1);
    expect(summary.free.tokens).toBe(190_000);
    expect(summary.free.count).toBe(1);
    expect(summary.used.tokens).not.toBe(8_000 + 190_000);
  });

  it('⭐⭐ buffer と deferred も、それぞれ自分の軸にだけ入り used には入らない', () => {
    const summary = summarizeContextCategories([
      { name: 'System prompt', tokens: 100, kind: 'used' },
      { name: 'Compaction reserve', tokens: 900, kind: 'buffer' },
      { name: 'Deferred tools', tokens: 50, kind: 'deferred' },
    ]);

    expect(summary.used.tokens).toBe(100);
    expect(summary.buffer.tokens).toBe(900);
    expect(summary.deferred.tokens).toBe(50);
    expect(summary.used.tokens).not.toBe(100 + 900);
    expect(summary.used.tokens).not.toBe(100 + 50);
  });

  it('⭐⭐⭐ kind の無い軸は unclassified に入り、used にも free にも入らない', () => {
    const summary = summarizeContextCategories([
      { name: 'System prompt', tokens: 8_000, kind: 'used' },
      { name: 'Messages', tokens: 500 },
    ]);

    expect(summary.unclassified.tokens).toBe(500);
    expect(summary.unclassified.count).toBe(1);
    expect(summary.used.tokens).toBe(8_000);
    expect(summary.free.tokens).toBe(0);
  });

  it('⭐⭐⭐ 未知の kind（将来 SDK が足す5つ目）も unclassified に入り、例外を投げない', () => {
    expect(() =>
      summarizeContextCategories([{ name: 'Something new', tokens: 42, kind: 'invented' }]),
    ).not.toThrow();

    const summary = summarizeContextCategories([
      { name: 'Something new', tokens: 42, kind: 'invented' },
    ]);
    expect(summary.unclassified.tokens).toBe(42);
    expect(summary.unclassified.count).toBe(1);
    expect(summary.used.tokens).toBe(0);
    expect(summary.free.tokens).toBe(0);
    expect(summary.buffer.tokens).toBe(0);
    expect(summary.deferred.tokens).toBe(0);
  });

  it('⭐⭐⭐ 名前ではなく kind で分類する — 紛らわしい名前を逆に置いても kind に従う', () => {
    const summary = summarizeContextCategories([
      { name: 'Free space', tokens: 1_000, kind: 'used' },
      { name: 'Messages', tokens: 2_000, kind: 'free' },
    ]);

    expect(summary.used.tokens).toBe(1_000);
    expect(summary.free.tokens).toBe(2_000);
  });

  it('カテゴリが undefined / 空配列でも、全軸が0件・0トークンで返る（例外を投げない）', () => {
    const fromUndefined = summarizeContextCategories(undefined);
    const fromEmpty = summarizeContextCategories([]);

    for (const summary of [fromUndefined, fromEmpty]) {
      expect(summary.used).toEqual({ tokens: 0, count: 0 });
      expect(summary.free).toEqual({ tokens: 0, count: 0 });
      expect(summary.buffer).toEqual({ tokens: 0, count: 0 });
      expect(summary.deferred).toEqual({ tokens: 0, count: 0 });
      expect(summary.unclassified).toEqual({ tokens: 0, count: 0 });
    }
  });

  it('複数の軸が同じ kind に属していれば、tokens も count も積み上がる', () => {
    const summary = summarizeContextCategories([
      { name: 'a', tokens: 10, kind: 'used' },
      { name: 'b', tokens: 20, kind: 'used' },
      { name: 'c', tokens: 30, kind: 'used' },
    ]);

    expect(summary.used).toEqual({ tokens: 60, count: 3 });
  });
});

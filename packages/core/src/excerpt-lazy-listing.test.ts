import { describe, expect, it } from 'vitest';

import {
  fillLazyListingBudget,
  fillListingBudget,
  renderListing,
  renderListingFromEnd,
} from './excerpt.js';

// 予算に入る分だけ行を作る（#6318 案 A）。出す文は、全行を先に作る形と1文字も変わらないこと、
// 予算に入らない行（積みを止めた1行を除く）を作らないことの歯。

function lazy(items: readonly string[]): {
  source: { count: number; build: (index: number) => string };
  built: number[];
} {
  const built: number[] = [];
  return {
    built,
    source: {
      count: items.length,
      build: (index) => {
        built.push(index);
        return items[index]!;
      },
    },
  };
}

const rows = Array.from({ length: 500 }, (_, i) => `- row ${i} ${'x'.repeat(100)}`);
const omitted = ({ rest, shown, total }: { rest: number; shown: number; total: number }): string =>
  `…ほか ${rest} 件（${total} 件中 ${shown} 件）`;

describe('fillLazyListingBudget', () => {
  it('先頭から積むとき、入る行と積みを止めた1行だけを作る', () => {
    const { source, built } = lazy(rows);
    const fill = fillLazyListingBudget(source, 1000, false);
    expect(fill.shown).toBeGreaterThan(0);
    expect(fill.shown).toBeLessThan(20);
    expect(built).toEqual(Array.from({ length: fill.shown + 1 }, (_, i) => i));
    expect(fill.total).toBe(500);
    expect(fill.rest).toBe(500 - fill.shown);
  });

  it('末尾から積むとき、新しい側から入る行と積みを止めた1行だけを作る', () => {
    const { source, built } = lazy(rows);
    const fill = fillLazyListingBudget(source, 1000, true);
    expect(built).toEqual(Array.from({ length: fill.shown + 1 }, (_, i) => 499 - i));
  });

  it('全部が入るときは止めた行が無く、全行を1回ずつ作る', () => {
    const { source, built } = lazy(rows.slice(0, 3));
    const fill = fillLazyListingBudget(source, 8000, false);
    expect(fill.shown).toBe(3);
    expect(built).toEqual([0, 1, 2]);
  });

  it('空の一覧は何も作らない', () => {
    const { source, built } = lazy([]);
    expect(fillLazyListingBudget(source, 100, false)).toEqual({
      lines: [],
      shown: 0,
      rest: 0,
      total: 0,
    });
    expect(built).toEqual([]);
  });

  it.each([false, true])('配列で渡した結果と同じ（fromEnd=%s）', (fromEnd) => {
    const { source } = lazy(rows);
    expect(fillLazyListingBudget(source, 1000, fromEnd)).toEqual(
      fillListingBudget(rows, 1000, fromEnd),
    );
  });

  it('1件目だけで予算を超えるときは、その1件を切って出し、2件目は作るだけで捨てる', () => {
    const { source, built } = lazy(['y'.repeat(500), 'z']);
    const fill = fillLazyListingBudget(source, 100, false);
    expect(fill.shown).toBe(1);
    expect(fill.lines[0]).toContain('文字省略');
    expect(built).toEqual([0, 1]);
  });
});

describe('renderListing / renderListingFromEnd は配列でも lazy でも同じ文を返す', () => {
  it('renderListing', () => {
    const { source } = lazy(rows);
    expect(renderListing(source, { budget: 1000, omitted })).toBe(
      renderListing(rows, { budget: 1000, omitted }),
    );
  });

  it('renderListingFromEnd', () => {
    const { source } = lazy(rows);
    expect(renderListingFromEnd(source, { budget: 1000, omitted })).toBe(
      renderListingFromEnd(rows, { budget: 1000, omitted }),
    );
  });
});

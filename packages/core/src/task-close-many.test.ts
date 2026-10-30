import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { chunkIdsByChars } from './tools.js';

// Task の一括（`task_set_status_many`）と daemon が共有する id 列の塊割りの歯だけを置く

describe('chunkIdsByChars（id の列を文字数の予算で塊に割る）', () => {
  it('14a. 塊を全部つなげると元の列に戻る（1つも落とさない・順序も保つ）', () => {
    const ids = Array.from({ length: 40 }, () => randomUUID());
    const chunks = chunkIdsByChars(ids, 100);
    expect(chunks.flat()).toEqual(ids);
  });

  it("14b. 各塊の join(' ') の長さは予算を超えない。ただし1つで予算を超える id は単独の塊として返る", () => {
    const normal = Array.from({ length: 10 }, () => randomUUID());
    const tooLong = 'x'.repeat(200);
    const ids = [...normal.slice(0, 5), tooLong, ...normal.slice(5)];
    const budget = 100;
    const chunks = chunkIdsByChars(ids, budget);

    const longChunkIndex = chunks.findIndex((chunk) => chunk.includes(tooLong));
    expect(longChunkIndex).toBeGreaterThanOrEqual(0);
    expect(chunks[longChunkIndex]).toEqual([tooLong]);

    for (const [index, chunk] of chunks.entries()) {
      if (index === longChunkIndex) continue;
      expect(chunk.join(' ').length).toBeLessThanOrEqual(budget);
    }
    expect(chunks.flat()).toEqual(ids);
  });

  it('14c. 空配列を渡すと空配列が返る', () => {
    expect(chunkIdsByChars([], 100)).toEqual([]);
  });

  it('14d. 境界: 塊の合計（区切り込み）がちょうど予算に一致するとき、分割しない', () => {
    const a = 'a'.repeat(10);
    const b = 'b'.repeat(9);
    const budget = 20;
    expect(chunkIdsByChars([a, b], budget).length).toBe(1);
    expect(chunkIdsByChars([a, b], budget)).toEqual([[a, b]]);

    const bPlusOne = 'b'.repeat(10);
    const split = chunkIdsByChars([a, bPlusOne], budget);
    expect(split.length).toBe(2);
    expect(split).toEqual([[a], [bPlusOne]]);
  });

  it('14e. 境界: 予算超えの id が先頭・末尾に在っても単独の塊になり、空の塊は生まれない', () => {
    const tooLong = 'x'.repeat(50);
    const budget = 10;

    const headChunks = chunkIdsByChars([tooLong, 'a', 'b'], budget);
    expect(headChunks[0]).toEqual([tooLong]);
    expect(headChunks.every((chunk) => chunk.length > 0)).toBe(true);
    expect(headChunks.flat()).toEqual([tooLong, 'a', 'b']);

    const tailChunks = chunkIdsByChars(['a', 'b', tooLong], budget);
    expect(tailChunks.at(-1)).toEqual([tooLong]);
    expect(tailChunks.every((chunk) => chunk.length > 0)).toBe(true);
    expect(tailChunks.flat()).toEqual(['a', 'b', tooLong]);

    const allTooLong = chunkIdsByChars([tooLong, tooLong], budget);
    expect(allTooLong).toEqual([[tooLong], [tooLong]]);
  });

  it('14f. 区切りは1文字ぶんとして数えている（chunkIdsByChars 内部の前提）', () => {
    const ids = ['aa', 'bb', 'cc'];
    const budget = 8;
    const chunks = chunkIdsByChars(ids, budget);
    expect(chunks).toEqual([ids]);
    expect(chunks[0]!.join(' ').length).toBe(budget);

    const chunksMinusOne = chunkIdsByChars(ids, budget - 1);
    expect(chunksMinusOne.length).toBeGreaterThan(1);
  });
});

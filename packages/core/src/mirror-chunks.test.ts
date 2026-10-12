import { describe, expect, it } from 'vitest';

import { approxJsonChars, chunkMirrorEntries, MIRROR_EVENT_MAX_CHARS } from './mirror-chunks.js';

function entry(text: string, n: number) {
  return { type: 'user', uuid: `u-${n}`, message: { content: [{ type: 'text', text }] } };
}

describe('生ログの写し（mirror）を、1件あたりの大きさに上限を付けて分ける（#4485）', () => {
  it('合計が上限を超えるなら、順を保ったまま複数に分け、どの塊も上限を超えない', () => {
    const entries = Array.from({ length: 40 }, (_, n) => entry('x'.repeat(100_000), n));

    const chunks = chunkMirrorEntries(entries, 1_000_000);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(entries);
    for (const chunk of chunks) {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(1_000_000);
    }
  });

  it('上限を1行だけで超える行は、その行だけで1つの塊にする（行の中身は切らない）', () => {
    const big = entry('y'.repeat(2_000_000), 1);
    const entries = [entry('a', 0), big, entry('b', 2)];

    const chunks = chunkMirrorEntries(entries, 1_000_000);

    expect(chunks).toEqual([[entries[0]], [big], [entries[2]]]);
  });

  it('上限に収まるなら、今までどおり1つの塊のまま', () => {
    const entries = [entry('a', 0), entry('b', 1)];

    expect(chunkMirrorEntries(entries, MIRROR_EVENT_MAX_CHARS)).toEqual([entries]);
    expect(chunkMirrorEntries([], MIRROR_EVENT_MAX_CHARS)).toEqual([]);
  });

  it('大きさの見積もりは、JSON の文字数を下回らない（上限の判定を甘くしない）', () => {
    const samples = [
      entry('x'.repeat(1000), 0),
      { a: [1, 2.5, -3, null, true, false], b: { 'k"ey': 'v\\a"l\n' }, c: '日本語' },
      { lone: 'a\ud800b', pair: '😀' },
      [],
      {},
    ];
    for (const sample of samples) {
      expect(approxJsonChars(sample)).toBeGreaterThanOrEqual(JSON.stringify(sample).length);
    }
  });
});

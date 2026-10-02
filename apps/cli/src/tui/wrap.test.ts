import { describe, expect, it } from 'vitest';

import { cellWidth, wrapDisplayLines, wrapLogical, wrapRichLine } from './wrap.js';

describe('wrapLogical（表示幅で折り返す）', () => {
  it('全角は 2 セルで数える（.length ではなく表示幅）', () => {
    // 幅 6 に全角 3 字が入る。.length で数えると 6 字入って 12 セルになる。
    expect(wrapLogical('あいうえおかきく', 6)).toEqual(['あいう', 'えおか', 'きく']);
    for (const row of wrapLogical('あいうえおかきく', 6))
      expect(cellWidth(row)).toBeLessThanOrEqual(6);
  });

  it('半角と全角が混ざっても幅を超えない', () => {
    const rows = wrapLogical('abc日本語def', 5);
    expect(rows.join('')).toBe('abc日本語def');
    for (const row of rows) expect(cellWidth(row)).toBeLessThanOrEqual(5);
  });

  it('異体字セレクタ付き絵文字を割らない（書記素単位）', () => {
    const rows = wrapLogical('⚠️⚠️⚠️', 4);
    expect(rows.join('')).toBe('⚠️⚠️⚠️');
    for (const row of rows) expect(row.length % 2).toBe(0); // 「⚠」と U+FE0F が別の行に分かれない
  });

  it('収まるなら 1 行、幅 0 以下は折り返さない', () => {
    expect(wrapLogical('hello', 10)).toEqual(['hello']);
    expect(wrapLogical('hello', 0)).toEqual(['hello']);
    expect(wrapLogical('', 3)).toEqual(['']);
  });

  it('幅より広い 1 文字でも必ず進む（無限ループしない）', () => {
    expect(wrapLogical('日本', 1)).toEqual(['日', '本']);
  });
});

describe('wrapDisplayLines', () => {
  it('埋め込みの改行で先に割る', () => {
    expect(wrapDisplayLines('ab\r\ncd\nef', 10)).toEqual(['ab', 'cd', 'ef']);
  });
});

describe('wrapRichLine（装飾を保ったまま折り返す）', () => {
  it('折り返しをまたいでも装飾が残り、同じ装飾は畳み直される', () => {
    const rows = wrapRichLine([{ text: 'ab' }, { text: 'cdef', bold: true }, { text: 'g' }], 3);
    expect(rows).toEqual([
      [{ text: 'ab' }, { text: 'c', bold: true }],
      [{ text: 'def', bold: true }],
      [{ text: 'g' }],
    ]);
  });

  it('空入力は空の行を 1 本返す', () => {
    expect(wrapRichLine([], 10)).toEqual([[]]);
  });
});

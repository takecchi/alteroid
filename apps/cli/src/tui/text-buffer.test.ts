import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';

import {
  backspace,
  bufferOf,
  caretIndexForColumn,
  clearBuffer,
  deleteForward,
  composerLayout,
  emptyBuffer,
  insert,
  moveLeft,
  moveRight,
  moveRowDown,
  moveRowUp,
  visibleLineRange,
  wrapComposerRows,
} from './text-buffer.js';
import { wrapLogical } from './wrap.js';

describe('編集', () => {
  it('キャレットの位置へ挿入し、キャレットを進める', () => {
    expect(insert(bufferOf('ac', 1), 'b')).toEqual({ value: 'abc', cursor: 2 });
  });

  it('何も変わらない操作は同じ参照を返す（再描画を省ける）', () => {
    const empty = emptyBuffer();
    expect(insert(empty, '')).toBe(empty);
    expect(backspace(empty)).toBe(empty);
    expect(moveLeft(empty)).toBe(empty);
    expect(moveRight(empty)).toBe(empty);
    expect(clearBuffer(empty)).toBe(empty);
  });

  it('サロゲートペア（絵文字）は 1 文字として消す・歩く', () => {
    const b = bufferOf('a😀');
    expect(backspace(b)).toEqual({ value: 'a', cursor: 1 });
    expect(moveLeft(b).cursor).toBe(1);
    expect(moveRight(bufferOf('😀a', 0)).cursor).toBe(2);
  });
});

describe('折り返しの幾何（composerLayout）', () => {
  it('全角を 2 セルで数えて折り返し、行は値を過不足なく覆う', () => {
    const rows = wrapComposerRows('あいうえお', 6);
    expect(rows.map((r) => r.text)).toEqual(['あいう', 'えお']);
    expect(rows.map((r) => [r.start, r.end])).toEqual([
      [0, 3],
      [3, 5],
    ]);
    expect(rows[1]?.continuation).toBe(true);
  });

  it('空白があれば単語の途中でなく空白で折る', () => {
    expect(wrapComposerRows('hello world', 8).map((r) => r.text)).toEqual(['hello ', 'world']);
  });

  it('折り返しの境目のキャレットは次の行に置く', () => {
    const { caret } = composerLayout(bufferOf('あいうえお', 3), 6);
    expect(caret).toEqual({ row: 1, col: 0 });
  });

  it('行がちょうど満杯で続きが無いときは、空の行を足してそこへ置く', () => {
    const layout = composerLayout(bufferOf('あいう'), 6);
    expect(layout.rows.map((r) => r.text)).toEqual(['あいう', '']);
    expect(layout.caret).toEqual({ row: 1, col: 0 });
  });

  it('幅が未定（未測定）なら折り返さない', () => {
    expect(wrapComposerRows('a'.repeat(500)).length).toBe(1);
  });

  it('↑↓ は見えている表示行で動く（桁はセルで保つ）', () => {
    const b = bufferOf('あいうえお', 5); // 2 行目の末尾
    const up = moveRowUp(b, 6);
    expect(up.cursor).toBe(2); // 1 行目で、直前と同じセル位置（2 字 = 4 セル）
    expect(moveRowDown(up, 6).cursor).toBe(5);
    expect(moveRowUp(bufferOf('abc', 0), 6)).toEqual(bufferOf('abc', 0));
  });

  it('caretIndexForColumn は書記素単位（全角の途中の列は手前に置く）', () => {
    expect(caretIndexForColumn('あい', 1)).toBe(0);
    expect(caretIndexForColumn('あい', 2)).toBe(1);
    expect(caretIndexForColumn('ab', 99)).toBe(2);
  });
});

describe('visibleLineRange', () => {
  it('短い入力はスクロールしない。超えたらキャレットが窓の下端に来る', () => {
    expect(visibleLineRange(3, 2, 6)).toEqual({ start: 0, end: 3 });
    expect(visibleLineRange(10, 9, 4)).toEqual({ start: 6, end: 10 });
    expect(visibleLineRange(10, 0, 4)).toEqual({ start: 0, end: 4 });
  });
});

describe('書記素の単位（#3649）', () => {
  const FAMILY = '👨‍👩‍👧';
  const DAKU = 'が'; // 結合文字の濁点（が）

  it('⚠️（VS16）を並べても、ログと同じ幾何で折り返す', () => {
    const rows = wrapComposerRows('⚠️⚠️⚠️⚠️⚠️', 6).map((r) => r.text);
    expect(rows).toEqual(wrapLogical('⚠️⚠️⚠️⚠️⚠️', 6));
    expect(rows.join('')).toBe('⚠️⚠️⚠️⚠️⚠️');
    expect(rows.every((t) => stringWidth(t) <= 6)).toBe(true);
  });

  it('ZWJ の絵文字は書記素の途中で切らない', () => {
    const value = FAMILY.repeat(3);
    const rows = wrapComposerRows(value, 4).map((r) => r.text);
    expect(rows).toEqual(wrapLogical(value, 4));
    expect(rows.join('')).toBe(value);
    expect(rows.every((t) => t.length % FAMILY.length === 0)).toBe(true);
  });

  it('結合文字の濁点は基底文字と離さない', () => {
    const rows = wrapComposerRows(DAKU.repeat(5), 4).map((r) => r.text);
    expect(rows).toEqual(wrapLogical(DAKU.repeat(5), 4));
    expect(rows.every((t) => t.length % 2 === 0)).toBe(true);
  });

  it('Backspace・Delete・左右移動は書記素 1 つぶん', () => {
    expect(backspace(bufferOf(`a${FAMILY}`))).toEqual({ value: 'a', cursor: 1 });
    expect(backspace(bufferOf('x⚠️'))).toEqual({ value: 'x', cursor: 1 });
    expect(backspace(bufferOf(`a${DAKU}`))).toEqual({ value: 'a', cursor: 1 });
    expect(moveLeft(bufferOf(`a${FAMILY}`)).cursor).toBe(1);
    expect(moveRight(bufferOf(`${FAMILY}a`, 0)).cursor).toBe(FAMILY.length);
    expect(deleteForward(bufferOf(`⚠️a`, 0))).toEqual({ value: 'a', cursor: 0 });
    expect(deleteForward(bufferOf(`${DAKU}a`, 0))).toEqual({ value: 'a', cursor: 0 });
  });

  it('改行の直後・直前でも隣の行の書記素を巻き込まない', () => {
    expect(backspace(bufferOf(`${FAMILY}\n`))).toEqual({ value: FAMILY, cursor: FAMILY.length });
    expect(deleteForward(bufferOf(`a\n${FAMILY}`, 2))).toEqual({ value: 'a\n', cursor: 2 });
  });

  it('caretIndexForColumn は書記素の開始位置を返す', () => {
    expect(caretIndexForColumn(`${FAMILY}a`, 1)).toBe(0);
    expect(caretIndexForColumn(`⚠️a`, 2)).toBe(2);
  });
});

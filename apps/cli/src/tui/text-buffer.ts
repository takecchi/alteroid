/**
 * 複数行の入力欄の純粋モデル（値 + キャレット位置）と、折り返しの幾何。
 * 出所: takecchi/codiva（MIT）`src/core/text-buffer.ts` と `src/core/composer-layout.ts`
 * （マウス選択まわりは借りていない）。
 *
 * 編集・移動はすべてここの純粋関数で、UI はキー → 操作の対応と描画だけをする。何も
 * 変わらない操作は**同じ参照**を返すので、呼び出し側は再描画を省ける。
 *
 * 入力欄は「表示行」で動く: 長い 1 行は折り返して複数の表示行になり、↑↓・描画・
 * カーソル位置はどれも同じ幾何（`composerLayout`）を通す。
 */
import stringWidth from 'string-width';

import { GRAPHEMES } from './wrap.js';

export interface TextBuffer {
  readonly value: string;
  /** `value` への UTF-16 index（0..value.length）。 */
  readonly cursor: number;
}

/** 入力欄が伸びる表示行数の上限（超えるとキャレット付近を内部スクロールする）。 */
export const INPUT_MAX_ROWS = 6;

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

export function emptyBuffer(): TextBuffer {
  return { value: '', cursor: 0 };
}

export function bufferOf(value: string, cursor: number = value.length): TextBuffer {
  return { value, cursor: clamp(cursor, 0, value.length) };
}

export function isEmptyBuffer(buf: TextBuffer): boolean {
  return buf.value.length === 0;
}

export function insert(buf: TextBuffer, str: string): TextBuffer {
  if (str.length === 0) return buf;
  const value = buf.value.slice(0, buf.cursor) + str + buf.value.slice(buf.cursor);
  return { value, cursor: buf.cursor + str.length };
}

export function newline(buf: TextBuffer): TextBuffer {
  return insert(buf, '\n');
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** サロゲートペア（絵文字など）は 2 単位ぶん 1 文字として歩く（間に入ると文字列が壊れる）。 */
function stepBack(value: string, i: number): number {
  return isLowSurrogate(value.charCodeAt(i - 1)) && isHighSurrogate(value.charCodeAt(i - 2))
    ? 2
    : 1;
}
function stepForward(value: string, i: number): number {
  return isHighSurrogate(value.charCodeAt(i)) && isLowSurrogate(value.charCodeAt(i + 1)) ? 2 : 1;
}

export function backspace(buf: TextBuffer): TextBuffer {
  if (buf.cursor === 0) return buf;
  const n = stepBack(buf.value, buf.cursor);
  return {
    value: buf.value.slice(0, buf.cursor - n) + buf.value.slice(buf.cursor),
    cursor: buf.cursor - n,
  };
}

/** 全部捨てる（Ctrl+U）。既に空なら同じ参照。 */
export function clearBuffer(buf: TextBuffer): TextBuffer {
  return isEmptyBuffer(buf) ? buf : emptyBuffer();
}

/** キャレットのある論理行（改行で区切った行）の先頭の index。 */
function lineStart(value: string, cursor: number): number {
  return value.lastIndexOf('\n', cursor - 1) + 1;
}

/** キャレットのある論理行の末尾（改行の手前、または末尾）の index。 */
function lineEnd(value: string, cursor: number): number {
  const i = value.indexOf('\n', cursor);
  return i === -1 ? value.length : i;
}

/** 論理行の先頭へ（Home / Ctrl+A）。折り返した表示行ではなく、改行で区切った行の先頭。 */
export function moveLineStart(buf: TextBuffer): TextBuffer {
  const to = lineStart(buf.value, buf.cursor);
  return to === buf.cursor ? buf : { value: buf.value, cursor: to };
}

/** 論理行の末尾へ（End / Ctrl+E）。 */
export function moveLineEnd(buf: TextBuffer): TextBuffer {
  const to = lineEnd(buf.value, buf.cursor);
  return to === buf.cursor ? buf : { value: buf.value, cursor: to };
}

/** キャレットの後ろの 1 文字を消す（Delete）。 */
export function deleteForward(buf: TextBuffer): TextBuffer {
  if (buf.cursor >= buf.value.length) return buf;
  const n = stepForward(buf.value, buf.cursor);
  return {
    value: buf.value.slice(0, buf.cursor) + buf.value.slice(buf.cursor + n),
    cursor: buf.cursor,
  };
}

/**
 * 直前の語を消す（Ctrl+W）。語は空白（改行を除く）で区切る — 日本語は語の切れ目が無いので、
 * 空白の無い連なりは 1 語として消える。行頭なら直前の改行 1 つを消す。
 */
export function deleteWordBack(buf: TextBuffer): TextBuffer {
  if (buf.cursor === 0) return buf;
  const { value } = buf;
  if (value[buf.cursor - 1] === '\n') {
    return {
      value: value.slice(0, buf.cursor - 1) + value.slice(buf.cursor),
      cursor: buf.cursor - 1,
    };
  }
  const blank = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '　';
  let i = buf.cursor;
  while (i > 0 && blank(value[i - 1])) i -= 1;
  while (i > 0 && !blank(value[i - 1]) && value[i - 1] !== '\n') i -= 1;
  return { value: value.slice(0, i) + value.slice(buf.cursor), cursor: i };
}

/** キャレットから論理行の末尾までを消す（Ctrl+K）。すでに行末なら、続く改行 1 つを消す。 */
export function deleteToLineEnd(buf: TextBuffer): TextBuffer {
  const end = lineEnd(buf.value, buf.cursor);
  const to = end === buf.cursor ? Math.min(buf.value.length, end + 1) : end;
  return to === buf.cursor
    ? buf
    : { value: buf.value.slice(0, buf.cursor) + buf.value.slice(to), cursor: buf.cursor };
}

export function moveLeft(buf: TextBuffer): TextBuffer {
  return buf.cursor === 0
    ? buf
    : { value: buf.value, cursor: buf.cursor - stepBack(buf.value, buf.cursor) };
}

export function moveRight(buf: TextBuffer): TextBuffer {
  return buf.cursor >= buf.value.length
    ? buf
    : { value: buf.value, cursor: buf.cursor + stepForward(buf.value, buf.cursor) };
}

/**
 * `column` セル目に来る書記素の開始 index（行末より右は `text.length`）。
 * 折り返しと同じ書記素単位で歩くので、描画の幅と厳密に逆写像になる。
 */
export function caretIndexForColumn(text: string, column: number): number {
  let cells = 0;
  let index = 0;
  let found: number | undefined = column <= 0 ? 0 : undefined;
  for (const { segment } of GRAPHEMES.segment(text)) {
    const w = stringWidth(segment);
    if (found === undefined && cells + w > column) found = index;
    cells += w;
    index += segment.length;
  }
  return found ?? text.length;
}

export interface ComposerRow {
  /** 表示行の文字列（`\n` を含まない）。 */
  readonly text: string;
  /** `value` 内でこの行が始まる index。 */
  readonly start: number;
  /** `value` 内でこの行が終わる index（排他）。 */
  readonly end: number;
  /** 折り返しの続きの行か。 */
  readonly continuation: boolean;
}

/** `❯ ` / `  ` の行頭が占めるセル数。折り返し幅は「箱の幅 − これ」。 */
export const COMPOSER_PREFIX_CELLS = 2;

function normalizeWidth(width?: number): number | undefined {
  return width === undefined || !Number.isFinite(width)
    ? undefined
    : Math.max(1, Math.floor(width));
}

function charAt(text: string, i: number): string {
  const cp = text.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/**
 * 1 論理行を `cap` セル以内の `[from, to)` へ割る。貪欲で、単語の途中で切るより直前の
 * 空白を優先する（空白は行末に残すので、全区間で行を過不足なく覆う）。`cap` より広い
 * 1 文字でも必ず 1 行を進める（無限ループしない）。
 */
function wrapLine(line: string, cap: number): { from: number; to: number }[] {
  const segments: { from: number; to: number }[] = [];
  let from = 0;
  for (;;) {
    let cells = 0;
    let i = from;
    let lastSpace = -1;
    while (i < line.length) {
      const ch = charAt(line, i);
      const w = stringWidth(ch);
      if (cells + w > cap) break;
      cells += w;
      i += ch.length;
      if (ch === ' ') lastSpace = i;
    }
    if (i >= line.length) {
      segments.push({ from, to: line.length });
      return segments;
    }
    let to = lastSpace > from && charAt(line, i) !== ' ' ? lastSpace : i;
    if (to <= from) to = from + charAt(line, from).length;
    segments.push({ from, to });
    from = to;
    if (from >= line.length) return segments;
  }
}

/** 値を `width` セルで折り返した表示行（必ず 1 行以上）。`width` 無しは論理行のまま。 */
export function wrapComposerRows(value: string, width?: number): ComposerRow[] {
  const cap = normalizeWidth(width);
  const rows: ComposerRow[] = [];
  let offset = 0;
  for (const line of value.split('\n')) {
    if (cap === undefined) {
      rows.push({ text: line, start: offset, end: offset + line.length, continuation: false });
    } else {
      for (const seg of wrapLine(line, cap)) {
        rows.push({
          text: line.slice(seg.from, seg.to),
          start: offset + seg.from,
          end: offset + seg.to,
          continuation: seg.from > 0,
        });
      }
    }
    offset += line.length + 1;
  }
  return rows;
}

export interface ComposerLayout {
  readonly rows: readonly ComposerRow[];
  /** キャレットの表示行と、その行の `text` 内の文字オフセット。 */
  readonly caret: { readonly row: number; readonly col: number };
}

/**
 * 折り返してキャレットの位置を求める。折り返しの境目では次の行に置く（次の文字が
 * 実際に出る場所）。行がちょうど満杯で続きが無いときは、端末のカーソルと同じく
 * 空の行を 1 本足してそこへ置く（見える幅の外へ描かない）。
 */
export function composerLayout(buffer: TextBuffer, width?: number): ComposerLayout {
  const cap = normalizeWidth(width);
  const rows = wrapComposerRows(buffer.value, width);
  const cursor = clamp(buffer.cursor, 0, buffer.value.length);
  let row = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r && cursor >= r.start && cursor <= r.end) row = i;
  }
  const current = rows[row];
  if (
    cap !== undefined &&
    current &&
    cursor === current.end &&
    stringWidth(current.text) >= cap &&
    rows[row + 1]?.continuation !== true
  ) {
    rows.splice(row + 1, 0, { text: '', start: cursor, end: cursor, continuation: true });
    return { rows, caret: { row: row + 1, col: 0 } };
  }
  return { rows, caret: { row, col: cursor - (current?.start ?? 0) } };
}

/** キャレットが `maxRows` 行の窓に収まる範囲 `[start, end)`。短い入力はスクロールしない。 */
export function visibleLineRange(
  totalLines: number,
  cursorRow: number,
  maxRows: number,
): { start: number; end: number } {
  const cap = Math.max(1, maxRows);
  if (totalLines <= cap) return { start: 0, end: totalLines };
  const start = clamp(cursorRow - cap + 1, 0, totalLines - cap);
  return { start, end: start + cap };
}

function caretCells(layout: ComposerLayout): number {
  const row = layout.rows[layout.caret.row];
  return stringWidth((row?.text ?? '').slice(0, layout.caret.col));
}

/** 1 表示行上へ（桁はセルで保つ）。最上段ではバッファの先頭へ。 */
export function moveRowUp(buffer: TextBuffer, width?: number): TextBuffer {
  const layout = composerLayout(buffer, width);
  const target = layout.rows[layout.caret.row - 1];
  if (!target) return buffer.cursor === 0 ? buffer : { value: buffer.value, cursor: 0 };
  const cursor = target.start + caretIndexForColumn(target.text, caretCells(layout));
  return cursor === buffer.cursor ? buffer : { value: buffer.value, cursor };
}

/** 1 表示行下へ。最下段ではバッファの末尾へ。 */
export function moveRowDown(buffer: TextBuffer, width?: number): TextBuffer {
  const layout = composerLayout(buffer, width);
  const target = layout.rows[layout.caret.row + 1];
  if (!target) {
    return buffer.cursor === buffer.value.length
      ? buffer
      : { value: buffer.value, cursor: buffer.value.length };
  }
  const cursor = target.start + caretIndexForColumn(target.text, caretCells(layout));
  return cursor === buffer.cursor ? buffer : { value: buffer.value, cursor };
}

// 出所: takecchi/codiva（MIT）`src/core/text-buffer.ts` と `src/core/composer-layout.ts`
// 何も変わらない操作は同じ参照を返す: 呼び出し側が再描画を省けるため
import stringWidth from 'string-width';

import { GRAPHEMES } from './wrap.js';

export interface TextBuffer {
  readonly value: string;
  readonly cursor: number;
}

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

// 書記素を 1 単位として歩く: 折り返し・ログの `wrapLogical` と同じ区切りなので、間に入って文字列を壊さないため
function graphemeBounds(value: string, idx: number): { start: number; end: number } | undefined {
  const from = lineStart(value, idx);
  let index = from;
  for (const { segment } of GRAPHEMES.segment(value.slice(from, lineEnd(value, idx) + 1))) {
    const end = index + segment.length;
    if (idx < end) return { start: index, end };
    index = end;
  }
  return undefined;
}
function stepBack(value: string, i: number): number {
  const b = graphemeBounds(value, i - 1);
  return b ? i - b.start : 1;
}
function stepForward(value: string, i: number): number {
  const b = graphemeBounds(value, i);
  return b ? b.end - i : 1;
}

export function backspace(buf: TextBuffer): TextBuffer {
  if (buf.cursor === 0) return buf;
  const n = stepBack(buf.value, buf.cursor);
  return {
    value: buf.value.slice(0, buf.cursor - n) + buf.value.slice(buf.cursor),
    cursor: buf.cursor - n,
  };
}

export function clearBuffer(buf: TextBuffer): TextBuffer {
  return isEmptyBuffer(buf) ? buf : emptyBuffer();
}

function lineStart(value: string, cursor: number): number {
  return value.lastIndexOf('\n', cursor - 1) + 1;
}

function lineEnd(value: string, cursor: number): number {
  const i = value.indexOf('\n', cursor);
  return i === -1 ? value.length : i;
}

export function moveLineStart(buf: TextBuffer): TextBuffer {
  const to = lineStart(buf.value, buf.cursor);
  return to === buf.cursor ? buf : { value: buf.value, cursor: to };
}

export function moveLineEnd(buf: TextBuffer): TextBuffer {
  const to = lineEnd(buf.value, buf.cursor);
  return to === buf.cursor ? buf : { value: buf.value, cursor: to };
}

export function deleteForward(buf: TextBuffer): TextBuffer {
  if (buf.cursor >= buf.value.length) return buf;
  const n = stepForward(buf.value, buf.cursor);
  return {
    value: buf.value.slice(0, buf.cursor) + buf.value.slice(buf.cursor + n),
    cursor: buf.cursor,
  };
}

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
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly continuation: boolean;
}

export const COMPOSER_PREFIX_CELLS = 2;

function normalizeWidth(width?: number): number | undefined {
  return width === undefined || !Number.isFinite(width)
    ? undefined
    : Math.max(1, Math.floor(width));
}

// `cap` より広い 1 文字でも必ず 1 行を進める: 無限ループしないため
function wrapLine(line: string, cap: number): { from: number; to: number }[] {
  const graphemes: { text: string; at: number; w: number }[] = [];
  let at = 0;
  for (const { segment } of GRAPHEMES.segment(line)) {
    graphemes.push({ text: segment, at, w: stringWidth(segment) });
    at += segment.length;
  }
  const segments: { from: number; to: number }[] = [];
  let g = 0;
  for (;;) {
    const from = graphemes[g]?.at ?? line.length;
    let cells = 0;
    let k = g;
    let lastSpace = -1;
    while (k < graphemes.length) {
      const cur = graphemes[k];
      if (!cur || cells + cur.w > cap) break;
      cells += cur.w;
      k += 1;
      if (cur.text === ' ') lastSpace = k;
    }
    if (k >= graphemes.length) {
      segments.push({ from, to: line.length });
      return segments;
    }
    let next = lastSpace > g && graphemes[k]?.text !== ' ' ? lastSpace : k;
    if (next <= g) next = g + 1;
    const to = graphemes[next]?.at ?? line.length;
    segments.push({ from, to });
    g = next;
    if (g >= graphemes.length) return segments;
  }
}

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
  readonly caret: { readonly row: number; readonly col: number };
}

// 折り返しの境目では次の行に置く: 次の文字が実際に出る場所のため
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

export function moveRowUp(buffer: TextBuffer, width?: number): TextBuffer {
  const layout = composerLayout(buffer, width);
  const target = layout.rows[layout.caret.row - 1];
  if (!target) return buffer.cursor === 0 ? buffer : { value: buffer.value, cursor: 0 };
  const cursor = target.start + caretIndexForColumn(target.text, caretCells(layout));
  return cursor === buffer.cursor ? buffer : { value: buffer.value, cursor };
}

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

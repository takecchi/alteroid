/**
 * CJK 幅を数えた折り返し。出所: takecchi/codiva（MIT）`src/core/scroll.ts` の
 * `wrapDisplayLines` / `wrapRichLine` と `src/core/graphemes.ts`。
 *
 * 幅は表示幅（`string-width`）で数える: 全角・絵文字は 2 セル。`.length` で数えると
 * 日本語は最大 2 倍ずれる。折り返しは書記素（グラフェム）単位 — コードポイント単位だと
 * 異体字セレクタ付き絵文字（`⚠️`）で幅がずれ、書記素の途中で切れる。
 */
import stringWidth from 'string-width';

import type { RichSpan } from './markdown.js';

export const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 改行の並び。折り返しの前に論理行へ割るのに使う。 */
export const LINE_BREAK = /\r\n|[\r\n\v\f]/;

/** 表示幅（セル）。 */
export function cellWidth(text: string): number {
  return stringWidth(text);
}

/** 改行を含まない 1 論理行を、`width` セル以内の物理行へ折り返す。 */
export function wrapLogical(logical: string, width: number): string[] {
  if (width <= 0 || stringWidth(logical) <= width) return [logical];
  const out: string[] = [];
  let line = '';
  let w = 0;
  for (const { segment } of GRAPHEMES.segment(logical)) {
    const cw = stringWidth(segment);
    if (w + cw > width && line.length > 0) {
      out.push(line);
      line = segment;
      w = cw;
    } else {
      line += segment;
      w += cw;
    }
  }
  out.push(line);
  return out;
}

/** 埋め込みの改行で先に割ってから折り返す。 */
export function wrapDisplayLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const logical of text.split(LINE_BREAK)) {
    for (const row of wrapLogical(logical, width)) out.push(row);
  }
  return out;
}

function sameRichStyle(a: RichSpan, b: RichSpan): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.dim === b.dim &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.tone === b.tone
  );
}

/**
 * 装飾付きの 1 論理行を物理行へ折り返す。書記素ごとに装飾を保ち、同じ装飾が続く
 * 部分は 1 つの span へ畳み直す。空入力は空の行を 1 本返す。
 */
export function wrapRichLine(spans: readonly RichSpan[], width: number): RichSpan[][] {
  const rows: RichSpan[][] = [];
  let row: RichSpan[] = [];
  let w = 0;
  const flush = (): void => {
    rows.push(row);
    row = [];
    w = 0;
  };
  const push = (segment: string, style: RichSpan): void => {
    const last = row[row.length - 1];
    if (last && sameRichStyle(last, style)) last.text += segment;
    else row.push({ ...style, text: segment });
  };
  for (const span of spans) {
    const style: RichSpan = { ...span, text: '' };
    for (const { segment } of GRAPHEMES.segment(span.text)) {
      const cw = stringWidth(segment);
      if (width > 0 && w + cw > width && w > 0) flush();
      push(segment, style);
      w += cw;
    }
  }
  flush();
  return rows;
}

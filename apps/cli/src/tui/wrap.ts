// 出所: takecchi/codiva（MIT）`src/core/scroll.ts` の `wrapDisplayLines` / `wrapRichLine` と `src/core/graphemes.ts`
// 幅を `.length` で数えない: 日本語は最大 2 倍ずれるため（表示幅は `string-width`）
// コードポイント単位で折り返さない: 異体字セレクタ付き絵文字で幅がずれ、書記素の途中で切れるため
import stringWidth from 'string-width';

import type { RichSpan } from './markdown.js';

export const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const LINE_BREAK = /\r\n|[\r\n\v\f]/;

export function cellWidth(text: string): number {
  return stringWidth(text);
}

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

export const TAB_WIDTH = 4;

// タブを空白へ展開してから折り返す: `string-width` はタブを幅 0 と数え、そのままだと端末の実際の幅とずれて行末が欠ける・行が溢れるため
export function expandTabs(text: string): string {
  if (!text.includes('\t')) return text;
  return text
    .split(/(\r\n|[\r\n\v\f])/)
    .map((part) => {
      if (!part.includes('\t')) return part;
      let out = '';
      let col = 0;
      for (const { segment } of GRAPHEMES.segment(part)) {
        if (segment === '\t') {
          const pad = TAB_WIDTH - (col % TAB_WIDTH);
          out += ' '.repeat(pad);
          col += pad;
        } else {
          out += segment;
          col += stringWidth(segment);
        }
      }
      return out;
    })
    .join('');
}

export function wrapDisplayLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const logical of expandTabs(text).split(LINE_BREAK)) {
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

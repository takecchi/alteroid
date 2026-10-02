/**
 * クローンの応答（Markdown）を、意味ロール付きの装飾 span の行へ落とす。
 * 出所: takecchi/codiva（MIT）`src/core/markdown.ts`（リンクの飛び先の扱いは借りていない）。
 *
 * 純粋・I/O 無し。依存は `marked` の lexer（字句解析だけ。HTML は作らない）。折り返しは
 * ここではしない（`wrap.ts`）。色は span の `tone` を theme が具体色へ当てる。
 */
import { marked, type Token, type Tokens } from 'marked';

export type MarkdownTone = 'heading' | 'code' | 'link' | 'quote' | 'marker';

export interface RichSpan {
  /** 改行を含まない。 */
  text: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  tone?: MarkdownTone;
}

/** 折り返し前の 1 論理行。空配列は空行。 */
export type RichLine = RichSpan[];

const BULLET = '• ';
const QUOTE_BAR = '│ ';
const RULE = '────────';

function inlineSpans(tokens: readonly Token[] | undefined, base: RichSpan): RichSpan[] {
  if (!tokens) return [];
  const out: RichSpan[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) out.push(...inlineSpans(t.tokens, base));
        else out.push({ ...base, text: t.text });
        break;
      }
      case 'strong':
        out.push(...inlineSpans((token as Tokens.Strong).tokens, { ...base, bold: true }));
        break;
      case 'em':
        out.push(...inlineSpans((token as Tokens.Em).tokens, { ...base, italic: true }));
        break;
      case 'del':
        out.push(...inlineSpans((token as Tokens.Del).tokens, { ...base, strikethrough: true }));
        break;
      case 'codespan':
        out.push({ ...base, tone: 'code', text: (token as Tokens.Codespan).text });
        break;
      case 'link': {
        const lk = token as Tokens.Link;
        out.push(...inlineSpans(lk.tokens, { ...base, underline: true, tone: 'link' }));
        break;
      }
      case 'image': {
        const im = token as Tokens.Image;
        out.push({ ...base, underline: true, tone: 'link', text: im.text || im.href });
        break;
      }
      case 'br':
        out.push({ ...base, text: '\n' });
        break;
      case 'escape':
        out.push({ ...base, text: (token as Tokens.Escape).text });
        break;
      case 'html':
        out.push({ ...base, text: (token as Tokens.HTML).text });
        break;
      default: {
        const generic = token as { text?: string; raw?: string };
        const text = generic.text ?? generic.raw;
        if (text) out.push({ ...base, text });
      }
    }
  }
  return out;
}

/** 埋め込みの改行（hard break）を含む span 列を論理行へ割る。 */
function spansToLines(spans: readonly RichSpan[]): RichLine[] {
  const lines: RichLine[] = [];
  let current: RichLine = [];
  lines.push(current);
  for (const span of spans) {
    span.text.split('\n').forEach((part, i) => {
      if (i > 0) {
        current = [];
        lines.push(current);
      }
      if (part.length > 0) current.push({ ...span, text: part });
    });
  }
  return lines;
}

/** 先頭・末尾の空行を落とし、連続する空行を 1 本へ畳む。 */
function tidy(lines: RichLine[]): RichLine[] {
  const out: RichLine[] = [];
  for (const line of lines) {
    const blank = line.length === 0;
    const prevBlank = out.length === 0 || out[out.length - 1]?.length === 0;
    if (blank && prevBlank) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1]?.length === 0) out.pop();
  return out;
}

function prefixLines(lines: RichLine[], lead: RichSpan, indent: RichSpan): RichLine[] {
  const rows = lines.length > 0 ? lines : [[]];
  return rows.map((line, i) => [i === 0 ? lead : indent, ...line]);
}

function listLines(token: Tokens.List): RichLine[] {
  const out: RichLine[] = [];
  let n = typeof token.start === 'number' ? token.start : 1;
  for (const item of token.items) {
    const marker = token.ordered ? `${n}. ` : BULLET;
    if (token.ordered) n += 1;
    const box = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
    const lead = `${marker}${box}`;
    const inner = tidy(blockLines(item.tokens));
    for (const line of prefixLines(
      inner,
      { text: lead, tone: 'marker' },
      { text: ' '.repeat(lead.length) },
    )) {
      out.push(line);
    }
  }
  return out;
}

function tableRow(cells: RichSpan[][]): RichLine {
  const out: RichLine = [];
  cells.forEach((cell, i) => {
    if (i > 0) out.push({ text: ' │ ', tone: 'marker' });
    out.push(...cell);
  });
  return out;
}

function tableLines(token: Tokens.Table): RichLine[] {
  const out: RichLine[] = [];
  out.push(tableRow(token.header.map((c) => inlineSpans(c.tokens, { text: '', bold: true }))));
  for (const row of token.rows) {
    out.push(tableRow(row.map((c) => inlineSpans(c.tokens, { text: '' }))));
  }
  return out;
}

function blockLines(tokens: readonly Token[]): RichLine[] {
  const out: RichLine[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        out.push([]);
        break;
      case 'heading':
        out.push(
          ...spansToLines(
            inlineSpans((token as Tokens.Heading).tokens, {
              text: '',
              bold: true,
              tone: 'heading',
            }),
          ),
        );
        break;
      case 'paragraph':
        out.push(...spansToLines(inlineSpans((token as Tokens.Paragraph).tokens, { text: '' })));
        break;
      case 'text': {
        const t = token as Tokens.Text;
        const spans = t.tokens ? inlineSpans(t.tokens, { text: '' }) : [{ text: t.text }];
        out.push(...spansToLines(spans));
        break;
      }
      case 'code':
        for (const line of (token as Tokens.Code).text.split('\n')) {
          out.push([{ text: line, tone: 'code', dim: true }]);
        }
        break;
      case 'blockquote':
        for (const line of blockLines((token as Tokens.Blockquote).tokens)) {
          out.push([{ text: QUOTE_BAR, tone: 'quote' }, ...line]);
        }
        break;
      case 'list':
        out.push(...listLines(token as Tokens.List));
        break;
      case 'table':
        out.push(...tableLines(token as Tokens.Table));
        break;
      case 'hr':
        out.push([{ text: RULE, tone: 'marker', dim: true }]);
        break;
      case 'html':
        for (const line of (token as Tokens.HTML).text.replace(/\n$/, '').split('\n')) {
          out.push([{ text: line }]);
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Markdown を装飾付きの論理行へ。lexer は寛容で壊れた入力でも投げない想定だが、
 * 呼び出し側（`log.ts`）は念のため例外を握って素の折り返しへ落とす。
 */
export function renderMarkdown(text: string): RichLine[] {
  return tidy(blockLines(marked.lexer(text)));
}

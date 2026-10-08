// 出所: takecchi/codiva（MIT）`src/core/markdown.ts`
import { marked, type Token, type Tokens } from 'marked';

import { sanitizeForTerminal } from '../redact.js';

export type MarkdownTone = 'heading' | 'code' | 'link' | 'quote' | 'marker';

export interface RichSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  tone?: MarkdownTone;
}

export type RichLine = RichSpan[];

// U+202A〜202E（埋め込み・上書き）と U+2066〜2069（分離）: 文字の並びを入れ替えて、別の文に見せかけられるため
const cp = (code: number): string => String.fromCodePoint(code);
const BIDI_CONTROLS = new RegExp(`[${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}]`, 'g');

function terminalSafe(text: string): string {
  return sanitizeForTerminal(text).replace(BIDI_CONTROLS, '');
}

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
        const style: RichSpan = { ...base, underline: true, tone: 'link' };
        // 端末へそのまま出す文字列: 制御文字と方向制御は、ここで除く（Web の markdown-mdast.ts と同じ範囲）
        const alt = terminalSafe(im.text);
        const href = terminalSafe(im.href);
        // alt だけにしない: 端末は画像を出せず、URL を捨てると在り処を辿れない
        if (!href) out.push({ ...style, text: alt });
        else if (!alt) out.push({ ...style, text: href });
        else {
          out.push({ ...style, text: alt });
          out.push({ ...base, tone: 'marker', text: '（' });
          out.push({ ...style, text: href });
          out.push({ ...base, tone: 'marker', text: '）' });
        }
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

export function renderMarkdown(text: string): RichLine[] {
  // 字句に分ける前に除く: ESC などが URL に入っていると画像・リンクとして解釈されず、生の文字のまま端末へ出るため
  return tidy(blockLines(marked.lexer(sanitizeForTerminal(text))));
}

// 出所: takecchi/codiva（MIT）`src/core/scroll.ts`（`logLines` / `logWindow` / `streamLines` / `scrollUp` / `scrollDown`）
// `<Static>` を使わない: 全画面では見えないため
import { cellWidth, expandTabs, LINE_BREAK, wrapLogical, wrapRichLine } from './wrap.js';
import { type RichSpan, renderMarkdown } from './markdown.js';

export type LogKind = 'user' | 'assistant' | 'tool' | 'system' | 'ask' | 'error';

export interface LogEntry {
  readonly seq: number;
  readonly kind: LogKind;
  readonly text: string;
  readonly approvalId?: string;
  readonly dropped?: number;
}

export interface DisplayLine {
  key: string;
  kind: LogKind;
  text: string;
  spans?: RichSpan[];
}

export function prefixFor(kind: LogKind): string {
  switch (kind) {
    case 'user':
      return '❯ ';
    case 'assistant':
      return '  ';
    case 'tool':
      return '  · ';
    case 'ask':
      return '  ? ';
    case 'error':
      return '  ✗ ';
    case 'system':
      return '  ! ';
  }
}

const MARKDOWN_KINDS: Partial<Record<LogKind, boolean>> = { assistant: true };

function safeRenderMarkdown(text: string): ReturnType<typeof renderMarkdown> | undefined {
  try {
    const lines = renderMarkdown(text);
    return lines.length > 0 ? lines : undefined;
  } catch {
    return undefined;
  }
}

function entryLines(rawEntry: LogEntry, width: number): DisplayLine[] {
  // 折り返しの前にタブを空白へ展開する: タブは幅 0 と数えられるが、端末は次のタブ位置まで進むため
  const entry = rawEntry.text.includes('\t')
    ? { ...rawEntry, text: expandTabs(rawEntry.text) }
    : rawEntry;
  const prefix = prefixFor(entry.kind);
  const indent = ' '.repeat(cellWidth(prefix));
  const content = Math.max(1, width - cellWidth(prefix));
  const out: DisplayLine[] = [];
  let i = 0;

  const rich = MARKDOWN_KINDS[entry.kind] ? safeRenderMarkdown(entry.text) : undefined;
  if (rich) {
    for (const line of rich) {
      for (const rowSpans of wrapRichLine(line, content)) {
        const lead = i === 0 ? prefix : indent;
        const spans = lead ? [{ text: lead } as RichSpan, ...rowSpans] : rowSpans;
        out.push({
          key: `${entry.seq}:${i}`,
          kind: entry.kind,
          text: spans.map((s) => s.text).join(''),
          spans,
        });
        i += 1;
      }
    }
    return out;
  }

  for (const logical of entry.text.split(LINE_BREAK)) {
    for (const row of wrapLogical(logical, content)) {
      out.push({
        key: `${entry.seq}:${i}`,
        kind: entry.kind,
        text: (i === 0 ? prefix : indent) + row,
      });
      i += 1;
    }
  }
  return out;
}

interface CachedRows {
  width: number;
  rows: DisplayLine[];
  pass: number;
}

// 追記のたびにログ全体を折り返し直さない: O(n²) で、Ink の測定キャッシュは上限なしなので同じ文字列を返し続けるのが肝心のため
export const MAX_CACHED_ROWS = 8_000;

const ENTRY_ROWS = new Map<LogEntry, CachedRows>();
let cachedRowCount = 0;
let currentPass = 0;

function cachedEntryLines(entry: LogEntry, width: number): DisplayLine[] {
  const hit = ENTRY_ROWS.get(entry);
  if (hit && hit.width === width) {
    hit.pass = currentPass;
    ENTRY_ROWS.delete(entry);
    ENTRY_ROWS.set(entry, hit);
    return hit.rows;
  }
  const rows = entryLines(entry, width);
  if (hit) {
    cachedRowCount -= hit.rows.length;
    ENTRY_ROWS.delete(entry);
  }
  ENTRY_ROWS.set(entry, { width, rows, pass: currentPass });
  cachedRowCount += rows.length;
  for (const [key, value] of ENTRY_ROWS) {
    if (cachedRowCount <= MAX_CACHED_ROWS) break;
    if (value.pass === currentPass) continue;
    ENTRY_ROWS.delete(key);
    cachedRowCount -= value.rows.length;
  }
  return rows;
}

export function clearLogLinesCache(): void {
  ENTRY_ROWS.clear();
  cachedRowCount = 0;
}

export function cachedLogRowCount(): number {
  return cachedRowCount;
}

export function logLines(entries: readonly LogEntry[], width: number): DisplayLine[] {
  currentPass += 1;
  const rows: DisplayLine[] = [];
  for (const entry of entries) {
    for (const row of cachedEntryLines(entry, width)) rows.push(row);
  }
  return rows;
}

// 整形もキャッシュもしない: 途中の `**` を整形するとデルタごとに全行の折り返しが変わり、Ink の測定キャッシュが伸び続けるため
// 末尾の空行を落とす: 改行が届いた瞬間に画面が 1 行跳ねないように
export function streamLines(text: string, width: number, cap: number): DisplayLine[] {
  const prefix = prefixFor('assistant');
  const indent = ' '.repeat(cellWidth(prefix));
  const content = Math.max(1, width - cellWidth(prefix));
  const logical = expandTabs(text).split(LINE_BREAK);
  let end = logical.length;
  while (end > 0 && (logical[end - 1] ?? '').trim().length === 0) end -= 1;
  const limit = cap > 0 ? cap : Number.POSITIVE_INFINITY;
  const chunks: DisplayLine[][] = [];
  let count = 0;
  for (let i = end - 1; i >= 0 && count < limit; i -= 1) {
    const chunk = wrapLogical(logical[i] ?? '', content).map((row, r) => ({
      key: `stream:${i}:${r}`,
      kind: 'assistant' as LogKind,
      text: (i === 0 && r === 0 ? prefix : indent) + row,
    }));
    chunks.unshift(chunk);
    count += chunk.length;
  }
  const rows: DisplayLine[] = [];
  for (const chunk of chunks) for (const row of chunk) rows.push(row);
  return rows.length > limit ? rows.slice(rows.length - limit) : rows;
}

export type ScrollAnchor = 'bottom' | number;

export interface LogWindow<T> {
  entries: T[];
  hiddenAbove: number;
  hiddenBelow: number;
  atBottom: boolean;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

// `rows` を超える行は描かない: Yoga は溢れた子をクリップせず縮めるので、窓を大きく取ると行が虫食いになるため
export function logWindow<T>(
  lines: readonly T[],
  rows: number,
  anchor: ScrollAnchor,
): LogWindow<T> {
  const n = lines.length;
  const cap = Math.max(1, rows);
  const end = anchor === 'bottom' ? n : clamp(anchor, Math.min(cap, n), n);
  const start = Math.max(0, end - cap);
  return {
    entries: lines.slice(start, end),
    hiddenAbove: start,
    hiddenBelow: n - end,
    atBottom: end >= n,
  };
}

export function pageStep(rows: number): number {
  return Math.max(1, Math.floor(Math.max(1, rows) / 2));
}

export function scrollUp(
  anchor: ScrollAnchor,
  total: number,
  rows: number,
  step: number = pageStep(rows),
): ScrollAnchor {
  const cap = Math.max(1, rows);
  if (total <= cap) return 'bottom';
  const end = anchor === 'bottom' ? total : Math.min(anchor, total);
  const next = Math.max(cap, end - Math.max(1, step));
  return next >= total ? 'bottom' : next;
}

export function scrollDown(
  anchor: ScrollAnchor,
  total: number,
  rows: number,
  step: number = pageStep(rows),
): ScrollAnchor {
  if (anchor === 'bottom') return 'bottom';
  const cap = Math.max(1, rows);
  const next = Math.max(cap, Math.min(anchor, total) + Math.max(1, step));
  return next >= total ? 'bottom' : next;
}

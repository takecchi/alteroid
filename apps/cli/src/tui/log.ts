/**
 * 会話ログの表示モデル: 論理エントリ → 物理行（折り返し済み）→ 可視窓。
 * 出所: takecchi/codiva（MIT）`src/core/scroll.ts`（`logLines` / `logWindow` /
 * `streamLines` / `scrollUp` / `scrollDown`）。URL 検出・ツール実行の畳みは借りていない。
 *
 * **スクロールの単位は物理行**である（複数行のエントリ 1 件で画面が埋まったり、PgUp の
 * 量が実際の行数とずれたりしないように）。全画面では `<Static>` は見えないので使わず、
 * 見えている窓の行だけを描く。
 */
import { cellWidth, expandTabs, LINE_BREAK, wrapLogical, wrapRichLine } from './wrap.js';
import { type RichSpan, renderMarkdown } from './markdown.js';

export type LogKind = 'user' | 'assistant' | 'tool' | 'system' | 'ask' | 'error';

export interface LogEntry {
  /** 一意な連番（描画 key の元）。 */
  readonly seq: number;
  readonly kind: LogKind;
  readonly text: string;
  /** 承認の行のとき、その承認の id（読み返しと再生で同じ承認を二重に出さないための印）。 */
  readonly approvalId?: string;
  /** 古い側を捨てた断りの行のとき、捨てた件数（累計）。 */
  readonly dropped?: number;
}

/** 物理行 1 本。`text` は prefix / 字下げを含む。`spans` は Markdown 由来の装飾付き版。 */
export interface DisplayLine {
  key: string;
  kind: LogKind;
  text: string;
  spans?: RichSpan[];
}

/** kind ごとの行頭（先頭行）。継続行は同じ幅の空白。 */
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

/** 応答テキストは Markdown として整形する。 */
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
  // タブは幅 0 と数えられ、端末は次のタブ位置まで進むので、折り返しの前に空白へ展開する（#3407）。
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

/**
 * 展開済みの行を覚えておく上限（柔らかい予算）。追記のたびにログ全体を折り返し直すと
 * O(n²) で、しかも毎回全行の新しい文字列を作る（Ink の測定キャッシュは上限なしなので
 * 同じ文字列を返し続けるのが肝心）。今回の呼び出しで使った行は追い出さない。
 */
export const MAX_CACHED_ROWS = 8_000;

const ENTRY_ROWS = new Map<LogEntry, CachedRows>();
let cachedRowCount = 0;
let currentPass = 0;

function cachedEntryLines(entry: LogEntry, width: number): DisplayLine[] {
  const hit = ENTRY_ROWS.get(entry);
  if (hit && hit.width === width) {
    hit.pass = currentPass;
    ENTRY_ROWS.delete(entry);
    ENTRY_ROWS.set(entry, hit); // Map の順序を「古い順」に保つ
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

/** 試験用: キャッシュを空にする（プロセス全体で 1 つの Map なので）。 */
export function clearLogLinesCache(): void {
  ENTRY_ROWS.clear();
  cachedRowCount = 0;
}

/** キャッシュしている行数（試験用）。 */
export function cachedLogRowCount(): number {
  return cachedRowCount;
}

/** エントリ列を `width` セルの物理行へ展開する。 */
export function logLines(entries: readonly LogEntry[], width: number): DisplayLine[] {
  currentPass += 1;
  const rows: DisplayLine[] = [];
  for (const entry of entries) {
    for (const row of cachedEntryLines(entry, width)) rows.push(row);
  }
  return rows;
}

/**
 * ストリーミング中の本文を物理行へ。**整形もキャッシュもしない**（途中の `**` を整形すると
 * デルタごとに全行の折り返しが変わり、Ink の測定キャッシュが伸び続ける）。末尾から
 * `cap` 行ぶんだけ折り返すので、本文がどれだけ長くなっても 1 デルタのコストは可視域で
 * 頭打ちになる。末尾の空行は落とす（改行が届いた瞬間に画面が 1 行跳ねないように）。
 */
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

/**
 * 窓の位置。`'bottom'` は末尾追従、数値は「排他的な終端 index」を固定したもの
 * （上へスクロール中は、追記があっても見ている場所がずれない）。
 */
export type ScrollAnchor = 'bottom' | number;

export interface LogWindow<T> {
  entries: T[];
  hiddenAbove: number;
  hiddenBelow: number;
  atBottom: boolean;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/**
 * アンカーを可視窓へ解く。`rows` を超える行は**描かない**: Yoga は溢れた子を
 * クリップせず縮めるので、窓を大きく取ると行が虫食いになる。終端は 1 画面ぶんで
 * 下限を打つ（最上部でも 1 ページ埋まる）。
 */
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

/** PgUp / PgDn が動かす行数（半画面）。 */
export function pageStep(rows: number): number {
  return Math.max(1, Math.floor(Math.max(1, rows) / 2));
}

/** 古い側へスクロールした新しいアンカー。全部が 1 画面に収まるなら動かない。 */
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

/** 新しい側へスクロールした新しいアンカー。末尾に届いたら `'bottom'`（追従へ戻る）。 */
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

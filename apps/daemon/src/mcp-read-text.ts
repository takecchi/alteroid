// MCP の読み取りの道具が「返す量」を締めるための純関数。道具の結果は向こうのモデルの文脈に入るので、既定は小さく、上限を必ず持つ。
// HTTP の API にはここの制限を掛けない（道具の面だけ）。

/** 道具の結果1つ（JSON にした長さ、UTF-16 の単位）の絶対の上限。超えたら切って返さず、狭め方を言って断る（切ると JSON が壊れ、黙って欠けた結果を渡すことになる） */
export const MCP_RESULT_MAX_CHARS = 60_000;

/** 本文の頁送りの既定の長さと上限（UTF-16 の単位） */
export const MCP_TEXT_DEFAULT_LENGTH = 4_000;
export const MCP_TEXT_MAX_LENGTH = 20_000;

/** 日誌の一覧で、1行の1つの文字列欄を切る長さの既定と上限 */
export const MCP_FIELD_DEFAULT_CHARS = 400;
export const MCP_FIELD_MAX_CHARS = 4_000;

export interface TextPage {
  /** 実際に返した範囲の始点（サロゲートペアの途中なら1つ手前へ寄る） */
  offset: number;
  /** 返した長さ */
  returned: number;
  /** 全体の長さ */
  total: number;
  /** 続きが在る（`nextOffset` から読める） */
  truncated: boolean;
  nextOffset: number | null;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** 文字数（UTF-16 の単位）の `offset` / `length` で切る。サロゲートペアは割らない */
export function sliceText(
  text: string,
  offset: number,
  length: number,
): { text: string; page: TextPage } {
  const total = text.length;
  let start = Math.min(Math.max(offset, 0), total);
  if (start > 0 && start < total && isLowSurrogate(text.charCodeAt(start))) start -= 1;
  let end = Math.min(start + length, total);
  if (end < total && end > start + 1 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return {
    text: text.slice(start, end),
    page: {
      offset: start,
      returned: end - start,
      total,
      truncated: end < total,
      nextOffset: end < total ? end : null,
    },
  };
}

/** 日誌の一覧で、1行の1つの配列に残す件数。文字列だけ切っても、件数の多い配列（添付・計時の行など）1つで頁が予算を超えるため */
export const MCP_ARRAY_MAX_ITEMS = 20;

/** 日誌の一覧1頁（JSON にした長さ）の安全値。`MCP_RESULT_MAX_CHARS` との差は、走査の印（`secretScan`）など道具の殻が足す分 */
export const MCP_PAGE_BUDGET_CHARS = 50_000;

/**
 * 構造の中の長い文字列（キーは切らない）を `max` 字で、長い配列を先頭 `maxItems` 件＋「他 M 件」の印で切る。
 * 切った印は文字列の末尾・配列の最後の要素に残し、切った個数（`cut`）と畳んだ配列の個数（`folded`）を返す
 */
export function capStrings<T>(
  value: T,
  max: number,
  maxItems: number = MCP_ARRAY_MAX_ITEMS,
): { value: T; cut: number; folded: number } {
  let cut = 0;
  let folded = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (node.length <= max) return node;
      cut += 1;
      const head = sliceText(node, 0, max).text;
      return `${head}…（以下省略。この欄は全 ${String(node.length)} 字）`;
    }
    if (Array.isArray(node)) {
      if (node.length <= maxItems) return node.map(walk);
      folded += 1;
      return [
        ...node.slice(0, maxItems).map(walk),
        `…（他 ${String(node.length - maxItems)} 件は省略。この配列は全 ${String(node.length)} 件）`,
      ];
    }
    if (typeof node === 'object' && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) {
        Object.defineProperty(out, key, {
          value: walk(item),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return node;
  };
  const result = walk(value) as T;
  return { value: result, cut, folded };
}

export interface CappedRow {
  /** 文字列・配列を締めた後の行 */
  row: Record<string, unknown>;
  id: string;
  at: string;
  type: string;
  /** 締める前の行の長さ（JSON、UTF-16 の単位） */
  originalChars: number;
  cut: number;
  folded: number;
}

export interface FittedJournalPage {
  entries: Record<string, unknown>[];
  next: { id: string; at: string } | null;
  fieldsTruncated: number;
  arraysTruncated: number;
  rowsDropped: number;
  rowsSummarized: number;
  notice?: string;
}

/**
 * 日誌の1頁を予算に収める。後ろの行から落とし、落としたら `next` を最後に残した行の継続点へ付け替える（全断しない）。
 * 1行だけで予算を超えるときは、その行を id / at / type / size の要約行にする（全文は `id` で頁送りして読む）。
 * `next` は元の頁の終端（`null`）を、落とした行が無いかぎり変えない（`null` のときだけ終端）。
 * `rest` は `entries` / `next` 以外の欄（`oldestAt` など）で、予算の計算に含める。
 */
export function fitJournalPage(
  rows: readonly CappedRow[],
  next: { id: string; at: string } | null,
  rest: Record<string, unknown>,
  budget: number,
): FittedJournalPage {
  // 組み上げ後の欄（fieldsTruncated・notice など）の分を見込んで、骨組みの長さに余裕を足す
  const overhead = JSON.stringify({ ...rest, entries: [], next }).length + 600;
  const lengths = rows.map((row) => JSON.stringify(row.row).length + 1);
  let keep = rows.length;
  let used = lengths.reduce((sum, length) => sum + length, 0);
  while (keep > 1 && overhead + used > budget) {
    keep -= 1;
    used -= lengths[keep] ?? 0;
  }
  const kept = rows.slice(0, keep);
  const dropped = rows.length - keep;

  let summarized = 0;
  const notes: string[] = [];
  const entries = kept.map((item, index) => {
    if (overhead + (lengths[index] ?? 0) <= budget) return item.row;
    summarized += 1;
    notes.push(
      `id ${item.id} の行は1行だけで頁の予算（${String(budget)} 字）を超える（全 ${String(item.originalChars)} 字）ので、` +
        'id / at / type / size だけの要約行にした。全文は `id` を渡して offset / length で頁送りして読む。',
    );
    return {
      id: item.id,
      at: item.at,
      type: item.type,
      size: item.originalChars,
      summarized: true,
    };
  });

  const last = kept.at(-1);
  if (dropped > 0 && last !== undefined) {
    notes.push(
      `頁の予算（${String(budget)} 字）を超えるので、後ろの ${String(dropped)} 行は返していない。` +
        '`next` を `afterId` / `afterAt` に渡して続きを読む。',
    );
  }
  return {
    entries,
    next: dropped > 0 && last !== undefined ? { id: last.id, at: last.at } : next,
    fieldsTruncated: kept.reduce((sum, item) => sum + item.cut, 0),
    arraysTruncated: kept.reduce((sum, item) => sum + item.folded, 0),
    rowsDropped: dropped,
    rowsSummarized: summarized,
    ...(notes.length === 0 ? {} : { notice: notes.join(' ') }),
  };
}

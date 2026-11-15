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

/** 構造の中の長い文字列（キーは切らない）を `max` 字で切る。切った印は文字列の末尾に残し、切った個数を返す */
export function capStrings<T>(value: T, max: number): { value: T; cut: number } {
  let cut = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (node.length <= max) return node;
      cut += 1;
      const head = sliceText(node, 0, max).text;
      return `${head}…（以下省略。この欄は全 ${String(node.length)} 字）`;
    }
    if (Array.isArray(node)) return node.map(walk);
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
  return { value: result, cut };
}

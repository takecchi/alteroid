/**
 * クローンの返信の本文に出る「繰り返しの崩壊」（同じ語・同じ行が延々と続く。#4142）を検知して切り詰める純粋関数。
 *
 * モデル側の症状で、同じターンの道具の呼び出しは壊れない。人間に見える本文だけが読めなくなる。
 * 読み手（Web・CLI・TUI）は日誌の `exchange` から本文を読むので、日誌へ書く前にここを通す。
 *
 * ## 規則（誤爆より見逃しを選ぶ。閾値は大きめ）
 *
 * - 前後の空白を除いて空でない**同じ行**が連続 {@link LINE_REPEAT_THRESHOLD} 回以上 → 繰り返し
 * - 1行の中で、空白で区切った**同じ語**（{@link TOKEN_MAX_LENGTH} 字以下）が連続
 *   {@link TOKEN_REPEAT_THRESHOLD} 回以上 → 繰り返し
 * - フェンス（```）で囲んだ中は対象にしない（コードやログの繰り返しは正当でありうる）
 * - 判定したら最初の1回だけ残し、残りを1行の注記に置き換える
 */

/** 同じ行がこの回数以上連続したら繰り返しとみなす。 */
export const LINE_REPEAT_THRESHOLD = 8;
/** 1行の中で同じ語がこの回数以上連続したら繰り返しとみなす。 */
export const TOKEN_REPEAT_THRESHOLD = 16;
/** 語としての繰り返しを見る長さの上限（字）。 */
export const TOKEN_MAX_LENGTH = 20;
/** 注記へ写す、繰り返された単位の先頭の長さ（字）。 */
const UNIT_EXCERPT_LENGTH = 40;

/** 切り詰めた1か所。`count` は**続いた回数**（残した1回を含む）。 */
export interface CollapsedRepetition {
  /** 繰り返された語・行（先頭 {@link UNIT_EXCERPT_LENGTH} 字まで）。 */
  unit: string;
  count: number;
  kind: 'line' | 'token';
}

export interface RepetitionCollapse {
  /** 切り詰めた後の本文。繰り返しが無ければ入力と同じ。 */
  text: string;
  collapsed: CollapsedRepetition[];
}

function excerpt(unit: string): string {
  const chars = [...unit];
  return chars.length <= UNIT_EXCERPT_LENGTH ? unit : chars.slice(0, UNIT_EXCERPT_LENGTH).join('');
}

function marker(unit: string, count: number): string {
  return `（以下、同じ「${excerpt(unit)}」が ${String(count)} 回続いたので省いた）`;
}

/** 1行の中の同じ語の連続を切り詰める。 */
function collapseTokensInLine(line: string, found: CollapsedRepetition[]): string {
  const tokens = [...line.matchAll(/\S+/gu)].map((m) => ({
    text: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
  let out = '';
  let cursor = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) break;
    let j = i + 1;
    if ([...token.text].length <= TOKEN_MAX_LENGTH) {
      while (tokens[j]?.text === token.text) j += 1;
    }
    const count = j - i;
    if (count >= TOKEN_REPEAT_THRESHOLD) {
      const last = tokens[j - 1];
      if (last === undefined) break;
      out += `${line.slice(cursor, token.end)} ${marker(token.text, count)}`;
      cursor = last.end;
      found.push({ unit: excerpt(token.text), count, kind: 'token' });
    }
    i = j;
  }
  return out + line.slice(cursor);
}

/**
 * 本文の繰り返しの崩壊を切り詰める。
 *
 * 行は `\n` で区切る（行末の `\r` は前後の空白として無視する）。戻りの `collapsed` が空なら、`text` は入力と同じ。
 */
export function collapseRepetition(text: string): RepetitionCollapse {
  const lines = text.split('\n');
  const found: CollapsedRepetition[] = [];
  const out: string[] = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      i += 1;
      continue;
    }
    if (inFence || trimmed === '') {
      out.push(line);
      i += 1;
      continue;
    }
    let j = i + 1;
    while ((lines[j] ?? '').trim() === trimmed && j < lines.length) j += 1;
    const count = j - i;
    if (count >= LINE_REPEAT_THRESHOLD) {
      out.push(line, marker(trimmed, count));
      found.push({ unit: excerpt(trimmed), count, kind: 'line' });
      i = j;
      continue;
    }
    out.push(collapseTokensInLine(line, found));
    i += 1;
  }
  return found.length === 0 ? { text, collapsed: [] } : { text: out.join('\n'), collapsed: found };
}

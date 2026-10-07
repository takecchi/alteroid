function count(value: number): string {
  return value.toLocaleString('en-US');
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

// 切り口だけコードポイントの境界へ寄せる: 高サロゲートだけが残ると、UTF-8 へ変える経路で黙って U+FFFD に化けるため
export function codePointBoundary(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  return isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end;
}

export function codePointStartBoundary(text: string, start: number): number {
  if (start <= 0 || start >= text.length) return start;
  return isLowSurrogate(text.charCodeAt(start)) ? start - 1 : start;
}

// コードポイント数で統一する: pg の `right()` と JS の `.length` が食い違うと、本文の先頭が静かに消えるため
export function tailByCodePoints(text: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return '';
  if (text.length <= maxCodePoints) return text;
  let index = text.length;
  for (let remaining = maxCodePoints; remaining > 0 && index > 0; remaining -= 1) {
    index = codePointStartBoundary(text, index - 1);
  }
  return text.slice(index);
}

export function countCodePoints(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; count += 1) {
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return count;
}

// 短ければ何も足さない: 毎回注記が付くと、本当に切れているときの目印が効かなくなるため
export function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = codePointBoundary(text, limit);
  const omitted = text.length - end;
  return `${text.slice(0, end)}…（${count(omitted)} 文字省略。全 ${count(text.length)} 文字）`;
}

export function excerptLine(text: string, limit: number): string {
  return excerpt(text.replace(/\s+/g, ' ').trim(), limit);
}

export interface Page {
  body: string;
  from: number;
  to: number;
  total: number;
  more: boolean;
}

export interface ListingBudget {
  budget: number;
  // 続きの取り方を書けるのは、呼び手の側に続きを取る口が実在するときだけ: 口が無いまま断り書きだけを出すと、落ちた分に呼び手から到達できないため
  omitted: (part: { rest: number; shown: number; total: number }) => string;
}

export interface ListingFill {
  lines: string[];
  shown: number;
  rest: number;
  total: number;
}

// 1件だけで予算を超える場合は、その1件を `excerpt` で切る: 落とすと何も出ない一覧になり、丸ごと出すと予算が意味を失うため
export function fillListingBudget(
  items: readonly string[],
  budget: number,
  fromEnd = false,
): ListingFill {
  const lines: string[] = [];
  let used = 0;
  if (fromEnd) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      if (lines.length === 0) {
        const tail = item.length > budget ? excerpt(item, budget) : item;
        lines.unshift(tail);
        used += tail.length;
        continue;
      }
      if (used + item.length > budget) break;
      lines.unshift(item);
      used += item.length;
    }
  } else {
    for (const item of items) {
      if (lines.length === 0) {
        const head = item.length > budget ? excerpt(item, budget) : item;
        lines.push(head);
        used += head.length;
        continue;
      }
      if (used + item.length > budget) break;
      lines.push(item);
      used += item.length;
    }
  }
  return { lines, shown: lines.length, rest: items.length - lines.length, total: items.length };
}

export function renderListing(
  items: readonly string[],
  { budget, omitted }: ListingBudget,
): string {
  const { lines, rest, shown, total } = fillListingBudget(items, budget, false);
  if (rest > 0) lines.push(omitted({ rest, shown, total }));
  return lines.join('\n');
}

export interface ListingEntryFields {
  id: string;
  // 概要の先頭 n 文字にしない: `summary` が既に出していて、欄が増えただけで情報は増えないため
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export function renderListingEntry(
  entry: ListingEntryFields & { extra?: readonly (string | null)[] },
): string {
  return [
    `- ${entry.id} ${entry.title}`,
    `  作成: ${entry.createdAt} / 更新: ${entry.updatedAt}`,
    `  ${entry.summary}`,
    ...(entry.extra ?? []).filter((line) => line !== null),
  ].join('\n');
}

// 断り書きは先頭へ置く: 落ちているのは古い側なので、末尾に置くと読み手が「この下にまだある」と読むため
export function renderListingFromEnd(
  items: readonly string[],
  { budget, omitted }: ListingBudget,
): string {
  const { lines, rest, shown, total } = fillListingBudget(items, budget, true);
  if (rest > 0) lines.unshift(omitted({ rest, shown, total }));
  return lines.join('\n');
}

export function page(text: string, offset: number, limit: number): Page {
  const from = Math.max(0, Math.min(Math.trunc(offset), text.length));
  // 1文字も進めなくなるとき（`limit` が1で先頭が補助面の文字）は戻さない
  const cut = codePointBoundary(text, Math.min(from + limit, text.length));
  const body = text.slice(from, cut > from ? cut : from + limit);
  const to = from + body.length;
  return { body, from, to, total: text.length, more: to < text.length };
}

export function describePage(part: Page): string {
  if (part.from === 0 && !part.more) return `全 ${count(part.total)} 文字`;
  return `${count(part.from + 1)}〜${count(part.to)} 文字目 / 全 ${count(part.total)} 文字`;
}

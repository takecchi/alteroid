/**
 * 抜粋 — **切るなら、切ったと分かる形で切る。**
 *
 * 黙って先頭だけ・末尾だけを渡すと、受け取った側はそれで全部だと思って
 * 全体像を組み立てる。「黙って引き下がる／黙って挑み続ける／黙って消す」を
 * 欠陥とみなすのと同じ理由で、**黙って落とす**のも欠陥である。
 *
 * ここを通したものには必ず「何文字省いたか」と「全部で何文字か」が付く。
 * 受け取った側は、欠落に気づけるし、全文を取りに行く判断ができる。
 */

function count(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * 先頭 `limit` 文字に抜粋し、省いた分量を明示する。
 *
 * 短ければ何も足さない（毎回の出力に注記が付くと、本当に切れているときの
 * 目印が効かなくなる）。
 */
export function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}…（${count(omitted)} 文字省略。全 ${count(text.length)} 文字）`;
}

/** 改行を潰したうえで抜粋する（1行に収めたい一覧用）。 */
export function excerptLine(text: string, limit: number): string {
  return excerpt(text.replace(/\s+/g, ' ').trim(), limit);
}

/**
 * 全文を順に取り出すための1ページ。
 *
 * 上限のある口（MCP の出力など）へ長い本文を出すときは、切って捨てるのでは
 * なく**続きの取り方を添えて切る**。分けて渡せば全部届く。
 */
export interface Page {
  /** このページの本文。 */
  body: string;
  /** 何文字目から始まっているか（0 起点）。 */
  from: number;
  /** どこまで出したか（次の `offset`）。 */
  to: number;
  /** 全体の文字数。 */
  total: number;
  /** まだ続きがあるか。 */
  more: boolean;
}

export function page(text: string, offset: number, limit: number): Page {
  const from = Math.max(0, Math.min(Math.trunc(offset), text.length));
  const body = text.slice(from, from + limit);
  const to = from + body.length;
  return { body, from, to, total: text.length, more: to < text.length };
}

/** ページの位置を人間にもモデルにも読める形で書く。 */
export function describePage(part: Page): string {
  if (part.from === 0 && !part.more) return `全 ${count(part.total)} 文字`;
  return `${count(part.from + 1)}〜${count(part.to)} 文字目 / 全 ${count(part.total)} 文字`;
}

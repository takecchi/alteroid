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

/**
 * 一覧を予算で積む。**切ったら、切った件数と続きの取り方を必ず出す。**
 *
 * ここに切り出してあるのは、**各一覧の実装の側に予算のループを手で書く形を
 * やめるため**である。`digest.ts` の冒頭が記録しているとおり、後から足した節が
 * 黙って切れていたのは「その行が各節の実装の側にあって、書き忘れても何も
 * 落ちなかったから」だった。同じ形が道具の側にもあり、`manager_list` /
 * `journal_read` が塞がれたあとも `approvals_list` / `schedule_list` /
 * `runner_list` は無上限のまま残っていた。**1か所に寄せれば、寄せ忘れは
 * 一覧の総当たり試験が拾える。**
 *
 * 予算の意味は「出力全体の文字数」であって件数ではない。件数から出力量を
 * 決めると、何件で壊れるかが運任せになる（それで一覧が丸ごと落ちた実績が
 * `manager_list` にある）。
 */
export interface ListingBudget {
  /** 本体（省略の断り書きを除く）の文字数の上限。 */
  budget: number;
  /**
   * 切ったときに最後へ足す1行。**続きの取り方をここで書く。**
   *
   * `shown` 件を出し、`rest` 件を省き、全部で `total` 件あった。
   */
  omitted: (part: { rest: number; shown: number; total: number }) => string;
}

/**
 * 予算に入るところまで `items` を積み、入らなかった分を断り書きにする。
 *
 * **1件だけで予算を超える場合は、その1件を `excerpt` で切る。** 落とすと
 * 「何も出ない一覧」になり、丸ごと出すと予算そのものが意味を失う——どちらも
 * 「上限がある」と言えなくなる。切った跡は `excerpt` が付ける。
 */
export function renderListing(
  items: readonly string[],
  { budget, omitted }: ListingBudget,
): string {
  const lines: string[] = [];
  let used = 0;
  for (const item of items) {
    if (lines.length === 0) {
      // 先頭の1件は必ず出す。ただし予算を超えるなら切って出す。
      const head = item.length > budget ? excerpt(item, budget) : item;
      lines.push(head);
      used += head.length;
      continue;
    }
    if (used + item.length > budget) break;
    lines.push(item);
    used += item.length;
  }
  const rest = items.length - lines.length;
  if (rest > 0) lines.push(omitted({ rest, shown: lines.length, total: items.length }));
  return lines.join('\n');
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

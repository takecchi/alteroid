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
   *
   * **⚠️ 「続きの取り方」を書けるのは、呼び手の側に続きを取る口が実在する
   * ときだけである。** 口が無いまま断り書きだけを出すと、落ちた分は**呼び手
   * から到達できない**——そして落ちるのは常に並びの末尾側なので、`at` 昇順
   * （古い順）の一覧では**新しい行だけが恒久的に窓の外へ出る。** 実害が出た
   * 実例が台帳（`tools.ts` の `commitment_list`）で、そちらは継続点
   * （`cursor`。`commitment-cursor.ts`）を足して塞いだ。**新しい一覧を
   * 足すときは、ここに何を書けるかを先に決めること。**
   *
   * **他の一覧が同じ形かどうかは数えていない。** `approvals_list` が同じ形
   * であることだけ確かめてある（issue #640）。
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

/**
 * 実体の一覧の1件が**必ず持つもの**。5つとも省略できない。
 *
 * **人間の依頼の逐語**: 「一覧系ツールは最低でも id + 名前 + 概要 + updated_at +
 * created_at が欲しい」。#208 と #215 でこれを手で揃えたが、**各実装の側で手で
 * 書いている限り、次に一覧を足す人が落としても何も落ちない。** それは
 * `digest.ts` の冒頭が逐語で記録している形そのものである:
 *
 * > 後から足した6節が黙って切れていたのは、**この行が各節の実装の側にあって
 * > 書き忘れても何も落ちなかったから**
 *
 * だから型で受ける。**5つを渡さなければコンパイルが通らない。**
 *
 * **⚠️ 型はこの口を通った場合しか守らない。** `renderListing` は低レベルの口として
 * 残っているので、それを直接呼んで手で組めば5項目を落とせる。**塞いでいるのは
 * 型ではなく歯のほう**である（`tools.test.ts` の「一覧は例外なく5項目を出す」）——
 * あれは**どの口を通ったかを見ず、出力に5項目が在るかを見る**ので、抜け道を
 * 通っても捕まる。
 */
export interface ListingEntryFields {
  /**
   * 詳細を取りに行く鍵。
   *
   * **抜粋にした一覧で、これが無い行は到達できない。** 一覧は「何があるか」を
   * 答えるものなので、そこから中身へ行けなければ一覧の意味が消える。
   */
  id: string;
  /**
   * 一覧を目で走らせるための短い札。
   *
   * **概要の先頭 n 文字にしないこと。** それは `summary` が既に出しているもので、
   * 欄が1つ増えただけで情報は増えない。その型で「最初に知りたいこと」を置く
   * （約束なら出所と種別、承認待ちなら質問の1行目、マネージャーなら状態）。
   */
  title: string;
  /** 中身の要旨。呼び手が `excerptLine` を通してから渡す（ラベルを付けるならそれも込み）。 */
  summary: string;
  /** このレコードが生まれた時刻。 */
  createdAt: string;
  /**
   * このレコードが**最後に変わった時刻**。
   *
   * **まだ一度も変わっていなければ `createdAt` と等しい。それは嘘ではなく観測で
   * ある**（軸は在って、値がまだ動いていないだけである）。ただし読み手が「値を
   * 作った」と読まないよう、**欄の意味は一覧の側で出力に書くこと。**
   */
  updatedAt: string;
}

/**
 * 実体の一覧の1件を、**決まった順**で組む。
 *
 * ```
 * - <id> <title>
 *   作成: <createdAt> / 更新: <updatedAt>
 *   <summary>
 *   <extra...>
 * ```
 *
 * **順を固定するのがこの関数の仕事である。** #208 / #215 で手で揃えた時点では、
 * `作成 / 更新` の行がブロックの2行目・3行目・5行目とばらばらだった（それが
 * 「各実装の側で手で書いている」ことの現れである）。**同じ位置に同じものが在る
 * ほうが、毎ターンこれを読む側は読める。**
 *
 * `extra` はその一覧だけが持つ行。**`  `（空白2つ）で始めること** — この関数は
 * 整形しない（何を出すかは一覧ごとに違い、ここで畳むと嘘になる）。`null` は落とす
 * ので、条件つきの行をそのまま並べてよい。
 */
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

/**
 * `renderListing` の**末尾を残す**版。落とすのは古い側（先頭）である。
 *
 * **並びが時系列で、続きを読む動機が「直近」にある一覧のためのものである。**
 * 会話を開くのはたいてい「さっきの続き」を思い出すためで、人が chat の履歴を
 * 開くと末尾が見えているのと同じ形になる。ここで先頭を残すと、いちばん要る
 * 直近の発言だけが消えたうえ、断り書きも「もっと遡れ」と逆向きの続きの
 * 取り方を案内することになる。
 *
 * **断り書きは先頭へ置く。** 落ちているのは古い側なので、穴が空いている場所は
 * 一覧の先頭である。末尾に置くと、読み手は「この下にまだある」と読む。
 *
 * `renderListing` と対にしてここへ置いてあるのは、**方向が違うだけの予算の
 * ループを、道具の側に手で書かせないため**である（それが3回踏んだ形である。
 * `renderListing` の doc を見ること）。
 */
export function renderListingFromEnd(
  items: readonly string[],
  { budget, omitted }: ListingBudget,
): string {
  const lines: string[] = [];
  let used = 0;
  // 末尾から詰める。`renderListing` と同じく、1件だけで予算を超えるなら切って出す。
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
  const rest = items.length - lines.length;
  if (rest > 0) lines.unshift(omitted({ rest, shown: lines.length, total: items.length }));
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

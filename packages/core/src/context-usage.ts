/**
 * `turn_usage.contextUsage.categories`（`schema.ts`）を `kind` で分類する
 * ——唯一の場所（#804 の写し漏れの修正）。
 *
 * ## なぜ要るか
 *
 * SDK の `getContextUsage()` が返す軸は `kind: 'used' | 'free' | 'buffer' |
 * 'deferred'` を持つ。SDK 自身がこの欄について逐語でこう言っている
 * （同梱の `sdk.d.ts`）:
 *
 * > [sdk-verbatim SDKControlGetContextUsageResponse.categories.kind]
 * > Classify on this, never on the English name.
 *
 * ところが `clone.ts` の `#observeContextUsage` は `{name, tokens}` だけを
 * 写して `kind` を捨てていた。⟹ 日誌の内訳には「毎ターン払っている入力
 * （`used`）」と「空き・compaction の予備・窓の外（`free` / `buffer` /
 * `deferred`）」が混ざったまま並び、**どちらも同じ形の数字なので、後から
 * 見分けられない。** 混ざった合計は「当たっているように見えて」間違える
 * ——見かけの文脈占有が高くても、その大半が `free`（空き）かもしれない。
 *
 * `clone.ts` / `tools.ts` / `self.ts` はどれもこの分類を必要とするが、
 * 分類のロジックを2本以上持たない——ここが唯一の場所で、他はここを呼ぶ。
 *
 * ## `tokens` は {@link ExactTokens}（#804 案2）
 *
 * `self.ts` の `describeCloneRuntime` は、この分類の合計（実トークン）を
 * 「文字数」（`injectedMemoryChars` / `systemPromptChars`。どちらも
 * `HeuristicChars`）と同じ画面へ並べて出す。**型がただの `number` のままだと、
 * 文字数をトークンとして読み替える経路が開いたままになる**——`quantity.ts`
 * モジュール冒頭の doc。ここで `ExactTokens` を名乗ることで、その代入を
 * `tsc` が落とす。
 */

import { exactTokens, type ExactTokens } from './quantity.js';

/** SDK が `categories[].kind` に持たせる4値（`sdk.d.ts` の逐語、上記）。 */
export const CONTEXT_CATEGORY_KINDS = ['used', 'free', 'buffer', 'deferred'] as const;

export type ContextCategoryKind = (typeof CONTEXT_CATEGORY_KINDS)[number];

/** ある `kind`（または「分類できなかった」側）に属する軸の合計と件数。 */
export interface ContextCategoryTotals {
  /**
   * SDK が実際に数えたトークン（{@link ExactTokens}。`quantity.ts`）。
   *
   * **文字数（`HeuristicChars`）とは代入できない**——モジュール冒頭の
   * 「`tokens` は `ExactTokens`」の節。
   */
  tokens: ExactTokens;
  /** その `kind` に属する軸の件数。**量ではないので単位を持たない。** */
  count: number;
}

/**
 * `categories` を `kind` で振り分けた結果。
 *
 * **`used` だけが「毎ターン払っている量」である。** `free` / `buffer` /
 * `deferred` / `unclassified` は1トークンも `used` に混ぜない——`used` を
 * 「実際に払っている入力」として読む経路がここより下流に在るため
 * （`self.ts` の `describeCloneRuntime` がまさにその読み替えを塞ぐために
 * 足された）。
 */
export interface ContextCategorySummary {
  /** 文脈窓を実際に占有している内容（システムプロンプト・道具・メッセージ等）。 */
  used: ContextCategoryTotals;
  /** 残りの窓。 */
  free: ContextCategoryTotals;
  /** compaction のための予備。 */
  buffer: ContextCategoryTotals;
  /** 窓の外に置かれた道具スキーマ等。 */
  deferred: ContextCategoryTotals;
  /**
   * **`kind` が無い軸、または未知の値を持つ軸。**
   *
   * `kind` が無いのは、この欄が増える前に書かれた行（`schema.ts` の
   * `contextUsage.categories[].kind` は `.optional()`）。未知の値は、SDK が
   * この4値より後に足した `kind` である——`z.string()` で受けている
   * （`schema.ts` の同じ欄の doc）ので、日誌へ書く時点では落ちない。
   *
   * **⚠️ ここへ倒すのは「取れなかった軸をそう名乗る」ためである
   * （`AGENTS.md` 地雷表「取れない軸に0の行を作る」の裏返し）。`used` へ
   * 倒さない——倒せば「毎ターン払っている量」に、分類できなかった量が
   * 紛れ込む。捨てもしない——捨てれば `categories` の合計と
   * `used+free+buffer+deferred+unclassified` の合計が食い違い、消えた分の
   * 存在そのものが見えなくなる。**
   */
  unclassified: ContextCategoryTotals;
}

function emptyTotals(): ContextCategoryTotals {
  return { tokens: exactTokens(0), count: 0 };
}

function isContextCategoryKind(value: string | undefined): value is ContextCategoryKind {
  if (value === undefined) return false;
  return (CONTEXT_CATEGORY_KINDS as readonly string[]).includes(value);
}

/**
 * `categories` を `kind` ごとに畳む。
 *
 * **分類は `kind` の値だけで行う。`name` の英語の文字列は1文字も見ない**
 * ——SDK の doc がそう言っている（モジュール冒頭の逐語）。`name` は SDK 側の
 * 表示名で、版が上がれば変わりうるし、変わっても赤くならない
 * （`schema.ts` の `contextUsage.categories` の doc「名前は SDK が決めた
 * 文字列であって、alteroid の語彙ではない」と同じ理由）。
 *
 * **例外を投げない。** 未知の `kind`（将来 SDK が5つ目を足した場合）は
 * `unclassified` へ入るだけで、呼び出しを止めない——`schema.ts` が
 * `categories[].kind` を `z.enum` ではなく `z.string()` にしている理由と
 * 対になっている（enum なら書き込み時点で落ちるが、読み出し・集計の
 * 側では未知の値が来ることを前提にする）。
 */
export function summarizeContextCategories(
  categories: readonly { name: string; tokens: number; kind?: string }[] | undefined,
): ContextCategorySummary {
  const summary: ContextCategorySummary = {
    used: emptyTotals(),
    free: emptyTotals(),
    buffer: emptyTotals(),
    deferred: emptyTotals(),
    unclassified: emptyTotals(),
  };
  for (const category of categories ?? []) {
    const bucket = isContextCategoryKind(category.kind)
      ? summary[category.kind]
      : summary.unclassified;
    // **`+=` ではなく明示の `exactTokens(...)` を通す。** `bucket.tokens`
    // は `ExactTokens`（branded number）で、`bucket.tokens + category.tokens`
    // の結果は算術演算子を通した時点で素の `number` に戻る——`quantity.ts`
    // の「引き算・足し算の結果は素の `number` に戻る」のとおり。単位付きの
    // 欄へ入れ直すこの1行が、ここで単位を名乗り直している印である。
    bucket.tokens = exactTokens(bucket.tokens + category.tokens);
    bucket.count += 1;
  }
  return summary;
}

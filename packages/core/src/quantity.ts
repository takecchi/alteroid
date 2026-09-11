/**
 * 単位付きの数量 — branded number（#804 案2）。
 *
 * ## なぜ要るか
 *
 * alteroid が「記憶の肥大」「毎ターンの床」を語るときに使っている数は
 * すべて `String.prototype.length`（文字数、UTF-16 コード単位）であって、
 * トークンではない。SDK の `getContextUsage()` が返す実トークン
 * （`context-usage.ts` の `summarizeContextCategories`）が同じ `self_status`
 * の画面に並ぶようになった（#804）ので、型の上で両者がただの `number` の
 * ままだと、**文字数をトークンとして読み替える経路（逆も同様）が常に
 * 開いたまま**になる。ここでその経路をコンパイルエラーにする。
 *
 * ## なぜ branded number であって `{ value, unit }` ではないか
 *
 * 実行時の表現を素の `number` のまま保つため。branded number は
 * `number & { readonly [BRAND]: {...} }` という交差型で、**実行時には
 * ただの number**（`as` でその場の型を名乗り直しているだけで、値を
 * 別の入れ物へ包んではいない）。だから `toLocaleString()` も比較演算子も
 * 算術演算子も既存のまま動き、**読む側（`number` を期待する箇所）は
 * 1行も直さなくてよい。** 塞がるのは**書く側**だけ——素の `number` を
 * 単位付きの欄へ直接代入できなくなる。
 *
 * `{ value: number, unit: 'chars' | 'tokens' }` のようにオブジェクトで
 * 包む案は採らなかった。読み手が毎回 `.value` を展開しないと使えなくなり、
 * 依頼段階の見積もりでは既存の呼び出し側（`toLocaleString()`・算術・比較）
 * の約193箇所がこの展開を強いられる——branded number ならその費用が
 * 掛からない（実行時の値がそのまま素の `number` なので、展開が要らない）。
 *
 * **この形自体は本ファイルが最初ではない**——`memory.ts` の `RenderedMemory`
 * （`renderMemoryDocuments` の戻り値だけがその型を持てるようにする印。
 * `grep -Fn -- '記憶の全文（branded type' packages/core/src/memory.ts`）が
 * 同じ `declare const ... unique symbol` の形を既に使っている。
 *
 * ## 🔴 `estimateKind` を「既定」にしない（依頼者の明示の条件）
 *
 * 構成子を {@link heuristicChars} / {@link exactTokens} の2本に分け、
 * **名前そのものが単位と確からしさを名乗る**形にしてある。引数を省略
 * できる形（例: `quantity(value, kind: EstimateKind = 'heuristic')`）は
 * 採らない——省略した呼び手が気づかないまま `heuristic` へ倒れる経路を
 * 作らないためである。
 *
 * **この条件そのものは型では強制できない**（`estimateKind` を省略可能な
 * 引数にするかどうかは実装者の選択であって、`tsc` はどちらの書き方も
 * 等しく通す）。だから**名前を2本の構成子へ割ることそのもの**で守る——
 * 「省略する」という操作自体が存在しない形にする。**「既定が安全」と
 * 「機構が安全を強制する」は別である**（依頼者の言葉）。既定値を安全側
 * （`heuristic`）に倒すことはできるが、それは「うっかり省略した」呼び出し
 * を正しく扱っているだけで、「省略」という操作そのものは残る——次に
 * 足す呼び手が同じ理由で安全側へ倒れるとは限らない。ここでは省略という
 * 操作そのものを構成子から消してある。
 */

declare const QUANTITY_BRAND: unique symbol;

/**
 * 単位（`Unit`）と確からしさ（`EstimateKind`）を型パラメータに持つ
 * branded number。
 *
 * 実行時の値は素の `number` そのもの——`[QUANTITY_BRAND]` はどの値にも
 * 実在しないプロパティで、`tsc` にだけ見えている（モジュール冒頭の
 * 「実行時の表現」の節）。
 */
type Quantity<Unit extends string, EstimateKind extends string> = number & {
  readonly [QUANTITY_BRAND]: { unit: Unit; estimateKind: EstimateKind };
};

/**
 * 文字数（`String.prototype.length`、UTF-16 コード単位）。
 *
 * **トークンの近似であって、トークンではない。** SDK の tokenizer を
 * 一度も通していない数——`memory.ts` の `MemoryFloor` や `self.ts` の
 * `CloneRuntimeFacts` が「毎ターンの床」として出している数はすべてこちら
 * 側である。
 */
export type HeuristicChars = Quantity<'chars', 'heuristic'>;

/**
 * SDK の token-count API（`getContextUsage()`）が数えた実トークン。
 *
 * `context-usage.ts` の `ContextCategoryTotals.tokens` がこちら側——
 * `kind`（`used`/`free`/`buffer`/`deferred`）で分類済みの、SDK 自身が
 * 数えた値である。
 */
export type ExactTokens = Quantity<'tokens', 'exact'>;

/**
 * 素の `number` を {@link HeuristicChars} として名乗り直す。
 *
 * **呼び手が「これは文字数であって、トークンの近似に過ぎない」と明示
 * するための1行。** `estimateKind` を選べる引数は持たない——このモジュール
 * 冒頭の「🔴 `estimateKind` を『既定』にしない」のとおり、名前そのものが
 * 確からしさを名乗る。
 */
export function heuristicChars(value: number): HeuristicChars {
  return value as HeuristicChars;
}

/**
 * 素の `number` を {@link ExactTokens} として名乗り直す。
 *
 * **呼び手が「これは SDK が実際に数えたトークンである」と明示するための
 * 1行。** {@link heuristicChars} と構成子を2本に分けてあるので、どちらを
 * 呼ぶかで確からしさを取り違えることが無い——呼び手が名前を間違えれば
 * それは呼び手の明示の誤りであって、既定への横滑りではない。
 */
export function exactTokens(value: number): ExactTokens {
  return value as ExactTokens;
}

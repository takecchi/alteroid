/**
 * 単位付きの数量（branded number）。
 *
 * `{ value, unit }` のオブジェクトで包まない: 読む側（`toLocaleString()`・算術・比較）が
 * 毎回 `.value` を展開することになるため。実行時は素の `number` のままにし、塞ぐのは
 * 書く側（素の `number` の直接代入）だけにする。
 *
 * 構成子を {@link heuristicChars} / {@link exactTokens} の2本に分け、`estimateKind` を
 * 省略可能な引数（既定値つき）にしない: 省略した呼び手が気づかないまま `heuristic` へ倒れる
 * 経路が残るため。この条件は型では強制できないので、省略という操作自体が無い形で守る。
 */

declare const QUANTITY_BRAND: unique symbol;

type Quantity<Unit extends string, EstimateKind extends string> = number & {
  readonly [QUANTITY_BRAND]: { unit: Unit; estimateKind: EstimateKind };
};

/** 文字数（UTF-16 コード単位）。トークンの近似であって、トークンではない。 */
export type HeuristicChars = Quantity<'chars', 'heuristic'>;

/** SDK の `getContextUsage()` が数えた実トークン。 */
export type ExactTokens = Quantity<'tokens', 'exact'>;

export function heuristicChars(value: number): HeuristicChars {
  return value as HeuristicChars;
}

export function exactTokens(value: number): ExactTokens {
  return value as ExactTokens;
}

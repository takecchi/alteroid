/**
 * `consolidation-cost` サブコマンド（Issue #136 / ADR 0089 / ADR 0090）が、統合の対象を
 * どう群へ分けるかを決める純関数だけを置く。
 *
 * **狙い**: 「id の安定した順に G 件ずつの群へ分け、群ごとに `runtime.consolidate()` を呼ぶ」
 * という手順のうち、DB にもLLMにも触れない部分（配列を切るだけ）を切り出し、
 * 契約を歯で固定する。呼び出し側（`consolidation-cost.ts`）は DB から読んだ
 * 現物の id 配列をそのままここへ渡すだけでよい。
 */

export interface ConsolidationGroups {
  /** 2件以上を含む群。`runtime.consolidate()` を呼ぶ対象。 */
  groups: string[][];
  /**
   * 末尾に残った、群にできなかった id（0件または1件）。
   * **この round では統合しない**——1件を1件に「統合」しないのは
   * `runtime.consolidate()` 自身の規律（ADR 0089 決定2 `single_eligible_source`）と同じ。
   * 次の round の候補プールへそのまま持ち越す。
   */
  leftover: string[];
}

/**
 * `ids` を先頭から `groupSize` 件ずつの連続した群へ切る。
 *
 * - `groupSize` 未満の最終群は「群」として扱わず `leftover` に回す
 *   （1件なら統合不能、0件なら単に割り切れた）。
 * - **並べ替えない。**`ids` は呼び出し側が既に「id の安定した順」で渡している前提であり、
 *   ここはその順序をそのまま連続する塊に切るだけである。
 *
 * @throws {Error} `groupSize` が2未満のとき。1件の群は定義上「群」ではない
 *   （`runtime.consolidate()` が `single_eligible_source` として扱う対象と同じ）。
 */
export function splitIntoConsolidationGroups(
  ids: readonly string[],
  groupSize: number,
): ConsolidationGroups {
  if (!Number.isInteger(groupSize) || groupSize < 2) {
    throw new Error(
      `splitIntoConsolidationGroups: groupSize は2以上の整数である必要がある(実際: ${groupSize})`,
    );
  }
  const groups: string[][] = [];
  let i = 0;
  while (i < ids.length) {
    const chunk = ids.slice(i, i + groupSize);
    i += groupSize;
    if (chunk.length < 2) {
      return { groups, leftover: chunk };
    }
    groups.push(chunk);
  }
  return { groups, leftover: [] };
}

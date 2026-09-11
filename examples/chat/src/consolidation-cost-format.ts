import type { ConsolidationCostRunJson, ConsolidationRoundJson } from "./consolidation-json.js";

/** `status: "measured"` のときだけ呼ばれる(`status: "weights_unavailable"` のときは
 *  呼び出し側がメトリクスを1つも出さずに打ち切る——`cli.ts` の `runConsolidationCostCommand`)。 */
type MeasuredConsolidationCostRunJson = Extract<ConsolidationCostRunJson, { status: "measured" }>;

/** 画面向けの人が読む要約(機械可読な出力は `MNEMORA_CONSOLIDATION_JSON` の側)。 */
export function formatConsolidationCostReport(json: MeasuredConsolidationCostRunJson): string {
  const lines: string[] = [];
  lines.push(
    `provider: llm=${json.llmMode} embedding=${json.embeddingMode}/${json.embeddingSpace.model}/${json.embeddingSpace.dimensions}次元`,
  );
  lines.push(
    `probeCount=${json.probeCount} haystackSize=${json.haystackSize} groupSize=${json.groupSize} ` +
      `recallLimit=${json.recallLimit} budgetLadder=[${json.budgetLadder.join(",")}]`,
  );
  lines.push(`stoppedAfterRound=${json.stoppedAfterRound} stopReason=${json.stopReason}`);
  lines.push("");
  lines.push(
    "| round | 統合(groups/llmCalls) | outcomes | activeCount | supersededCount | " +
      "activeContentChars | activeContentTokens | activeDigestChars | activeDigestTokens | " +
      "allContentChars |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const round of json.rounds) {
    lines.push(formatRoundStoreRow(round));
  }
  lines.push("");
  lines.push(
    "| round | budget | 平均carriedCount | 平均carriedDigestTokens | 平均goldRank(除外件数) | 平均recalledActiveShare |",
  );
  lines.push("|---|---|---|---|---|---|");
  for (const round of json.rounds) {
    lines.push(formatRoundRecallRow(round, "unbudgeted", round.recall.unbudgeted.mean));
    for (const rung of round.recall.budgeted) {
      lines.push(formatRoundRecallRow(round, `budget=${rung.budgetTokens}`, rung.mean));
    }
  }
  return lines.join("\n");
}

function formatRoundStoreRow(round: ConsolidationRoundJson): string {
  const c = round.consolidation;
  const consolidationCell = c ? `${c.groups}/${c.llmCalls}` : "(統合前)";
  const outcomesCell = c
    ? Object.entries(c.outcomes)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${kind}:${count}`)
        .join(" ") || "(無し)"
    : "(無し)";
  const s = round.store;
  return (
    `| ${round.round} | ${consolidationCell} | ${outcomesCell} | ${s.activeCount} | ` +
    `${s.supersededCount} | ${s.activeContentChars} | ${s.activeContentTokens} | ` +
    `${s.activeDigestChars} | ${s.activeDigestTokens} | ${s.allContentChars} |`
  );
}

function formatRoundRecallRow(
  round: ConsolidationRoundJson,
  label: string,
  mean: ConsolidationRoundJson["recall"]["unbudgeted"]["mean"],
): string {
  const goldRankCell =
    mean.goldRank === null
      ? `(無し, 除外${mean.goldRankExcludedCount}件)`
      : `${mean.goldRank.toFixed(2)}(除外${mean.goldRankExcludedCount}件)`;
  return (
    `| ${round.round} | ${label} | ${mean.carriedCount.toFixed(2)} | ` +
    `${mean.carriedDigestTokens.toFixed(2)} | ${goldRankCell} | ` +
    `${mean.recalledActiveShare.toFixed(3)} |`
  );
}

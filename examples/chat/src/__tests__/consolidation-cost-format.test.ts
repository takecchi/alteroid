import { describe, expect, it } from "vitest";
import { formatConsolidationCostReport } from "../consolidation-cost-format.js";
import { buildConsolidationCostRunJson } from "../consolidation-json.js";
import type { ConsolidationRoundJson } from "../consolidation-json.js";

function makeRound(
  round: number,
  overrides: Partial<ConsolidationRoundJson> = {},
): ConsolidationRoundJson {
  const probe = {
    probeId: "color",
    carriedCount: 3,
    carriedDigestTokens: 12,
    usageChars: 30,
    usageEstimatedTokens: 10,
    usageIndexChars: 5,
    totalInScope: 20,
    goldRank: 1,
    recalledActiveShare: 0.3,
    omittedKinds: [],
    budgetExceeded: false,
  };
  const mean = {
    carriedCount: 3,
    carriedDigestTokens: 12,
    usageChars: 30,
    usageEstimatedTokens: 10,
    usageIndexChars: 5,
    totalInScope: 20,
    recalledActiveShare: 0.3,
    goldRank: 1,
    goldRankExcludedCount: 0,
  };
  return {
    round,
    consolidation:
      round === 0
        ? null
        : {
            groups: 2,
            llmCalls: 2,
            outcomes: {
              consolidated: 2,
              nothing_to_consolidate: 0,
              not_examined: 0,
              llm_failed: 0,
              dry_run: 0,
            },
            newMemoryCount: 2,
            embeddingStatus: { ok: 2, pending: 0, failed: 0 },
            embeddingFailureKinds: [],
          },
    store: {
      activeCount: 10,
      supersededCount: round,
      activeContentChars: 100,
      activeContentTokens: 40,
      activeDigestChars: 20,
      activeDigestTokens: 8,
      allContentChars: 100 + round * 10,
    },
    recall: {
      unbudgeted: { probes: [probe], mean },
      budgeted: [{ budgetTokens: 32, probes: [probe], mean }],
    },
    ...overrides,
  };
}

describe("formatConsolidationCostReport", () => {
  it("例外を投げず、主要な数字を含む文字列を返す", () => {
    const json = buildConsolidationCostRunJson({
      llmMode: "deterministic",
      embeddingMode: "local",
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      probeCount: 1,
      haystackSize: 6,
      groupSize: 3,
      budgetLadder: [32],
      recallLimit: 50,
      stoppedAfterRound: 1,
      stopReason: "completed_all_rounds",
      rounds: [makeRound(0), makeRound(1)],
      measuredAt: new Date(),
      commit: null,
    });
    const report = formatConsolidationCostReport(json);
    expect(report).toContain("llm=deterministic");
    expect(report).toContain("groupSize=3");
    expect(report).toContain("stoppedAfterRound=1");
    expect(report).toContain("(統合前)");
    expect(report).toContain("consolidated:2");
    expect(report).toContain("budget=32");
  });

  it("goldRank が null(除外あり)の round でも例外を投げない", () => {
    const round = makeRound(0);
    round.recall.unbudgeted.mean = {
      ...round.recall.unbudgeted.mean,
      goldRank: null,
      goldRankExcludedCount: 1,
    };
    const json = buildConsolidationCostRunJson({
      llmMode: "deterministic",
      embeddingMode: "local",
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      probeCount: 1,
      haystackSize: 6,
      groupSize: 3,
      budgetLadder: [],
      recallLimit: 50,
      stoppedAfterRound: 0,
      stopReason: "insufficient_candidates",
      rounds: [round],
      measuredAt: new Date(),
      commit: null,
    });
    expect(() => formatConsolidationCostReport(json)).not.toThrow();
    expect(formatConsolidationCostReport(json)).toContain("(無し, 除外1件)");
  });
});

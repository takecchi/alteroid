import { describe, expect, it } from "vitest";
import { formatConsolidationCostReport } from "../consolidation-cost-format.js";
import { buildConsolidationCostRunJson } from "../consolidation-json.js";
import type { ConsolidationAbortJson, ConsolidationRoundJson } from "../consolidation-json.js";

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
      abort: null,
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
      abort: null,
    });
    expect(() => formatConsolidationCostReport(json)).not.toThrow();
    expect(formatConsolidationCostReport(json)).toContain("(無し, 除外1件)");
  });
});

function baseOptionsFor(rounds: ConsolidationRoundJson[], abort: ConsolidationAbortJson | null) {
  return {
    llmMode: "deterministic" as const,
    embeddingMode: "local" as const,
    embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
    probeCount: 1,
    haystackSize: 6,
    groupSize: 3,
    budgetLadder: [32],
    recallLimit: 50,
    stoppedAfterRound: 2,
    stopReason: abort !== null ? ("aborted_on_error" as const) : ("completed_all_rounds" as const),
    rounds,
    measuredAt: new Date(),
    commit: null,
    abort,
  };
}

describe("formatConsolidationCostReport — round途中の例外による打ち切り(abort)", () => {
  it(
    "round 3 で打ち切った場合、round 0/1/2 のデータの値・注入した cause の連鎖・sqlState が" +
      "すべて出力に残る(測れた分を捨てず、cause を畳まない)",
    () => {
      // ⚠ 歯の入力はリテラルで置く(測定対象の実装から導かない)。
      const abort: ConsolidationAbortJson = {
        round: 3,
        causeChain: ["outer-format-test-message-7q2z", "inner-format-test-message-k9x1"],
        sqlState: "23503",
      };
      const rounds = [makeRound(0), makeRound(1), makeRound(2)];
      const json = buildConsolidationCostRunJson(baseOptionsFor(rounds, abort));

      const report = formatConsolidationCostReport(json);

      // (2) round < N(=3) の行が出力に在る(=測れた分を捨てていない)。
      expect(report).toContain("| 0 |");
      expect(report).toContain("| 1 |");
      expect(report).toContain("| 2 |");
      // round ごとに変わる実データ値(makeRound の allContentChars = 100 + round*10)。
      expect(report).toContain("100"); // round0
      expect(report).toContain("110"); // round1
      expect(report).toContain("120"); // round2

      // (3) 元の cause のメッセージ(または sqlState)が含まれる(=畳んでいない)。
      expect(report).toContain("outer-format-test-message-7q2z");
      expect(report).toContain("inner-format-test-message-k9x1");
      expect(report).toContain("23503");

      expect(report).toContain("stoppedAfterRound=2 stopReason=aborted_on_error");
      expect(report).toContain("round 3");
    },
  );

  it("sqlState が無い(null)ときは「なし」と明示する(空文字・省略にしない)", () => {
    const abort: ConsolidationAbortJson = {
      round: 1,
      causeChain: ["no-sqlstate-message-2xk9"],
      sqlState: null,
    };
    const json = buildConsolidationCostRunJson(baseOptionsFor([makeRound(0)], abort));
    const report = formatConsolidationCostReport(json);
    expect(report).toContain("sqlState=なし");
  });

  it(
    "abort:null のときは打ち切りを示す行が1行も無い" +
      "(正常系の出力は今日と同じ形のまま——打ち切りの表と完走した表を混同しない歯)",
    () => {
      const rounds = [makeRound(0), makeRound(1)];
      const jsonNoAbort = buildConsolidationCostRunJson(baseOptionsFor(rounds, null));
      const report = formatConsolidationCostReport(jsonNoAbort);
      expect(report).not.toContain("sqlState=");
      expect(report).not.toContain("実行中に例外");
    },
  );
});

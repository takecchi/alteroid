import { heuristicTokenCounter } from "@mnemora/core";
import { describe, expect, it } from "vitest";
import {
  buildConsolidationCostRunJson,
  buildConsolidationMeanJson,
  buildConsolidationProbeJson,
  buildConsolidationStoreJson,
  buildWeightsUnavailableConsolidationCostRunJson,
  carriedDigestTokensOf,
  computeRecalledActiveShare,
  emptyOutcomeCounts,
  meanExcludingNullGoldRank,
} from "../consolidation-json.js";
import type { ConsolidationRecallProbeJson, RawProbeMeasurement } from "../consolidation-json.js";

describe("computeRecalledActiveShare", () => {
  it("carriedCount / activeCount", () => {
    expect(computeRecalledActiveShare(5, 10)).toBeCloseTo(0.5);
    expect(computeRecalledActiveShare(10, 10)).toBeCloseTo(1);
  });

  it("activeCount が0以下なら0を返す(NaN/Infinityを出さない)", () => {
    expect(computeRecalledActiveShare(5, 0)).toBe(0);
    expect(computeRecalledActiveShare(0, 0)).toBe(0);
  });
});

describe("meanExcludingNullGoldRank", () => {
  it("null が無ければ普通の平均、除外件数は0", () => {
    const result = meanExcludingNullGoldRank([1, 2, 3]);
    expect(result.mean).toBeCloseTo(2);
    expect(result.excludedCount).toBe(0);
  });

  it("null を除いて平均し、除いた件数を返す", () => {
    const result = meanExcludingNullGoldRank([1, null, 3, null]);
    expect(result.mean).toBeCloseTo(2);
    expect(result.excludedCount).toBe(2);
  });

  it("全件 null なら mean は null、excludedCount は全件数", () => {
    const result = meanExcludingNullGoldRank([null, null]);
    expect(result.mean).toBeNull();
    expect(result.excludedCount).toBe(2);
  });

  it("空配列なら mean は null、excludedCount は0", () => {
    const result = meanExcludingNullGoldRank([]);
    expect(result.mean).toBeNull();
    expect(result.excludedCount).toBe(0);
  });
});

describe("carriedDigestTokensOf", () => {
  it("digest を「\\n」で連結した1本に heuristicTokenCounter を当てる(docs/recall.md §6 と同じ数え方)", () => {
    const digests = ["abc", "defgh"];
    const expected = heuristicTokenCounter.count(digests.join("\n")).tokens;
    expect(carriedDigestTokensOf(digests)).toBe(expected);
    // 連結後に数える(個別に数えて足すのとは異なりうる)ことの確認——空文字を混ぜても
    // 「\n」区切りの1本として数える。
    expect(carriedDigestTokensOf([])).toBe(heuristicTokenCounter.count("").tokens);
  });
});

function rawProbe(overrides: Partial<RawProbeMeasurement> = {}): RawProbeMeasurement {
  return {
    probeId: "color",
    memoryDigests: ["digest one", "digest two"],
    goldRank: 1,
    totalInScope: 20,
    omittedKinds: [],
    usageChars: 100,
    usageEstimatedTokens: 40,
    usageIndexChars: 10,
    budgetExceeded: false,
    ...overrides,
  };
}

describe("buildConsolidationProbeJson", () => {
  it("carriedCount は memoryDigests.length、carriedDigestTokens は連結して数えた値", () => {
    const raw = rawProbe();
    const json = buildConsolidationProbeJson(raw, 10);
    expect(json.probeId).toBe("color");
    expect(json.carriedCount).toBe(2);
    expect(json.carriedDigestTokens).toBe(
      heuristicTokenCounter.count(raw.memoryDigests.join("\n")).tokens,
    );
    expect(json.recalledActiveShare).toBeCloseTo(0.2);
    expect(json.goldRank).toBe(1);
    expect(json.usageChars).toBe(100);
    expect(json.usageEstimatedTokens).toBe(40);
    expect(json.usageIndexChars).toBe(10);
    expect(json.totalInScope).toBe(20);
    expect(json.omittedKinds).toEqual([]);
    expect(json.budgetExceeded).toBe(false);
  });

  it("omittedKinds は写しであり、呼び出し側の元配列を変更しても影響しない", () => {
    const original = ["budget_dropped"];
    const raw = rawProbe({ omittedKinds: original });
    const json = buildConsolidationProbeJson(raw, 10);
    original.push("over_limit");
    expect(json.omittedKinds).toEqual(["budget_dropped"]);
  });

  it("goldRank が null なら null のまま伝わる(0 や -1 に化けない)", () => {
    const json = buildConsolidationProbeJson(rawProbe({ goldRank: null }), 10);
    expect(json.goldRank).toBeNull();
  });
});

describe("buildConsolidationMeanJson", () => {
  it("数値欄は単純平均、goldRank は null を除いた平均+除外件数", () => {
    const probes: ConsolidationRecallProbeJson[] = [
      buildConsolidationProbeJson(
        rawProbe({ probeId: "a", goldRank: 1, memoryDigests: ["x"] }),
        10,
      ),
      buildConsolidationProbeJson(
        rawProbe({ probeId: "b", goldRank: null, memoryDigests: [] }),
        10,
      ),
      buildConsolidationProbeJson(
        rawProbe({ probeId: "c", goldRank: 3, memoryDigests: ["y", "z"] }),
        10,
      ),
    ];
    const mean = buildConsolidationMeanJson(probes);
    expect(mean.goldRank).toBeCloseTo(2); // (1+3)/2、null(b)は除外
    expect(mean.goldRankExcludedCount).toBe(1);
    expect(mean.carriedCount).toBeCloseTo((1 + 0 + 2) / 3);
  });

  it("全 probe が goldRank:null なら mean.goldRank は null", () => {
    const probes = [
      buildConsolidationProbeJson(rawProbe({ probeId: "a", goldRank: null }), 10),
      buildConsolidationProbeJson(rawProbe({ probeId: "b", goldRank: null }), 10),
    ];
    const mean = buildConsolidationMeanJson(probes);
    expect(mean.goldRank).toBeNull();
    expect(mean.goldRankExcludedCount).toBe(2);
  });
});

describe("buildConsolidationStoreJson", () => {
  it("active の content/digest 文字数・トークン数を数え、allContentChars はそのまま渡す", () => {
    const json = buildConsolidationStoreJson({
      activeContentsAndDigests: [
        { content: "hello world", digest: "hi" },
        { content: "foo", digest: "bar" },
      ],
      supersededCount: 3,
      allContentChars: 999,
    });
    expect(json.activeCount).toBe(2);
    expect(json.supersededCount).toBe(3);
    expect(json.activeContentChars).toBe("hello world".length + "foo".length);
    expect(json.activeDigestChars).toBe("hi".length + "bar".length);
    expect(json.allContentChars).toBe(999);
    expect(json.activeContentTokens).toBe(
      heuristicTokenCounter.count(["hello world", "foo"].join("\n")).tokens,
    );
    expect(json.activeDigestTokens).toBe(
      heuristicTokenCounter.count(["hi", "bar"].join("\n")).tokens,
    );
  });

  it("active が0件でも0で埋まる(NaNにならない)", () => {
    const json = buildConsolidationStoreJson({
      activeContentsAndDigests: [],
      supersededCount: 0,
      allContentChars: 0,
    });
    expect(json.activeCount).toBe(0);
    expect(json.activeContentChars).toBe(0);
    expect(json.activeContentTokens).toBe(0);
  });
});

describe("emptyOutcomeCounts", () => {
  it("5値すべてが0", () => {
    expect(emptyOutcomeCounts()).toEqual({
      consolidated: 0,
      nothing_to_consolidate: 0,
      not_examined: 0,
      llm_failed: 0,
      dry_run: 0,
    });
  });
});

describe("buildConsolidationCostRunJson", () => {
  it("与えたメタデータをそのまま組み立てる", () => {
    const measuredAt = new Date("2026-01-01T00:00:00.000Z");
    const json = buildConsolidationCostRunJson({
      llmMode: "deterministic",
      embeddingMode: "local",
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      probeCount: 7,
      haystackSize: 60,
      groupSize: 5,
      budgetLadder: [32, 64],
      recallLimit: 50,
      stoppedAfterRound: 3,
      stopReason: "completed_all_rounds",
      rounds: [],
      measuredAt,
      commit: "abc",
    });
    expect(json.schemaVersion).toBe(1);
    expect(json.status).toBe("measured");
    expect(json.measuredAt).toBe(measuredAt.toISOString());
    expect(json.commit).toBe("abc");
    expect(json.llmMode).toBe("deterministic");
    expect(json.embeddingMode).toBe("local");
    expect(json.probeCount).toBe(7);
    expect(json.haystackSize).toBe(60);
    expect(json.groupSize).toBe(5);
    expect(json.budgetLadder).toEqual([32, 64]);
    expect(json.recallLimit).toBe(50);
    expect(json.stoppedAfterRound).toBe(3);
    expect(json.stopReason).toBe("completed_all_rounds");
    expect(json.rounds).toEqual([]);
  });

  it("budgetLadder は写しであり、呼び出し側配列の変更に影響されない", () => {
    const ladder = [32, 64];
    const json = buildConsolidationCostRunJson({
      llmMode: "deterministic",
      embeddingMode: "deterministic",
      embeddingSpace: { provider: "testkit", model: "deterministic", dimensions: 8 },
      probeCount: 0,
      haystackSize: 0,
      groupSize: 5,
      budgetLadder: ladder,
      recallLimit: 50,
      stoppedAfterRound: 0,
      stopReason: "insufficient_candidates",
      rounds: [],
      measuredAt: new Date(),
      commit: null,
    });
    ladder.push(999);
    expect(json.budgetLadder).toEqual([32, 64]);
  });
});

describe("buildWeightsUnavailableConsolidationCostRunJson", () => {
  it("メトリクスの欄を一切持たない(0/nullで埋めない)", () => {
    const measuredAt = new Date("2026-01-01T00:00:00.000Z");
    const json = buildWeightsUnavailableConsolidationCostRunJson({
      measuredAt,
      commit: null,
      detail: "重みを取得できなかったので、値は測っていない: network error",
    });
    expect(json.schemaVersion).toBe(1);
    expect(json.status).toBe("weights_unavailable");
    expect(json.measuredAt).toBe(measuredAt.toISOString());
    expect(json.commit).toBeNull();
    expect("rounds" in json).toBe(false);
    expect("llmMode" in json).toBe(false);
    if (json.status === "weights_unavailable") {
      expect(json.detail).toContain("重みを取得できなかったので、値は測っていない");
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  buildMeasuredIdentifierProbeJson,
  buildWeightsUnavailableIdentifierProbeJson,
} from "../identifier-json.js";
import type { ArmReport } from "../retrieval-quality.js";
import type { IdentifierArmReport } from "../identifier-arm.js";

/**
 * Issue #109: `identifier-json.ts` の出力口。DB もネットワークも要らない(純関数)。
 *
 * ⭐ **「重みを取得できなかった」と「測ったが値が悪かった」が型で区別され、
 * 前者に0や既定値を混ぜていないこと**を見る——`cli.ts` の `runIdentifierProbes` が
 * `warmup()` 失敗時にこの形を書き出す。
 */

function minimalJapaneseReport(): ArmReport {
  return {
    armLabel: "jp",
    tenantId: "t",
    llmMode: "deterministic",
    embeddingMode: "local",
    ingest: {
      observationCount: 74,
      drain: { ticks: 1, totalProcessed: 74, totalFailed: 0, firstTickProcessed: 74 },
      extractionCounts: { ok: 74, skipped: 0, llmFailedWholeObservation: 0 },
      measurement: "measured",
      singleTickWouldHaveStalled: false,
    },
    probes: [],
    mrrOverall: 0.81,
    mrrLexicalControl: 1,
    mrrNonLexical: 0.778,
    usageReport: "no calls",
  };
}

function minimalIdentifierReport(
  haystackKind: "sparse" | "dense",
  overrides: Partial<IdentifierArmReport> = {},
): IdentifierArmReport {
  return {
    armLabel: `id-${haystackKind}`,
    tenantId: `t2-${haystackKind}`,
    llmMode: "deterministic",
    embeddingMode: "local",
    haystackKind,
    ingest: {
      observationCount: 84,
      drain: { ticks: 1, totalProcessed: 84, totalFailed: 0, firstTickProcessed: 84 },
    },
    probes: [],
    mrrOverall: 1,
    hit1Count: 12,
    hit10Count: 12,
    probeCount: 12,
    ...overrides,
  };
}

describe("buildMeasuredIdentifierProbeJson", () => {
  it("(provider, model, dimensions) と haystackKind を3群すべてに同居させる", () => {
    const json = buildMeasuredIdentifierProbeJson({
      japaneseReport: minimalJapaneseReport(),
      identifierSparseReport: minimalIdentifierReport("sparse"),
      identifierDenseReport: minimalIdentifierReport("dense", { mrrOverall: 0.5 }),
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      measuredAt: new Date("2026-09-10T00:00:00.000Z"),
      commit: "abc123",
    });
    expect(json.status).toBe("measured");
    if (json.status !== "measured") {
      throw new Error("unreachable");
    }
    const expectedSpace = { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 };
    expect(json.japanese.embeddingSpace).toEqual(expectedSpace);
    expect(json.identifiersSparse.embeddingSpace).toEqual(expectedSpace);
    expect(json.identifiersDense.embeddingSpace).toEqual(expectedSpace);

    // haystackKind — 3群のうちどれ1つも落とさない(マネージャー指示)。
    expect(json.japanese.haystackKind).toBe("sparse");
    expect(json.identifiersSparse.haystackKind).toBe("sparse");
    expect(json.identifiersDense.haystackKind).toBe("dense");

    expect(json.japanese.mrrOverall).toBe(0.81);
    expect(json.identifiersSparse.mrrOverall).toBe(1);
    expect(json.identifiersDense.mrrOverall).toBe(0.5);
  });
});

describe("buildWeightsUnavailableIdentifierProbeJson", () => {
  it("メトリクスの欄を一切持たない(0/nullで埋めない)", () => {
    const json = buildWeightsUnavailableIdentifierProbeJson({
      measuredAt: new Date("2026-09-10T00:00:00.000Z"),
      commit: "abc123",
      detail: "重みを取得できなかったので、値は測っていない: simulated",
    });
    expect(json.status).toBe("weights_unavailable");
    expect(json).not.toHaveProperty("japanese");
    expect(json).not.toHaveProperty("identifiersSparse");
    expect(json).not.toHaveProperty("identifiersDense");
    if (json.status !== "weights_unavailable") {
      throw new Error("unreachable");
    }
    expect(json.detail).toContain("重みを取得できなかったので、値は測っていない");
  });
});

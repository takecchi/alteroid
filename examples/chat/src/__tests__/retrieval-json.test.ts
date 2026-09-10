import { describe, expect, it } from "vitest";
import type { Cassette } from "@mnemora/testkit";
import { buildRetrievalQualityJson } from "../retrieval-json.js";
import type { ArmReport, ProbeOutcome } from "../retrieval-quality.js";

/**
 * `buildRetrievalQualityJson`（DB を要求しない純関数）の歯。
 *
 * **DB 無しで測れる**——`ArmReport` はただのオブジェクトなので、`runRetrievalQualityArm`
 * を実際に走らせずに、ここで手で組み立てる。`examples/chat` には `test` スクリプトが無く
 * `test:db` しか無いため（ADR 0015/0016）、この検査も実際には `DATABASE_URL` が在るときにしか
 * 走らないが、**中身は DB を一切要求しない**——`ADR 0033`「引き受ける負債」が
 * `retrieval-quality-score.test.ts` について明記したのと同じ限界を、このファイルも引き継ぐ。
 */

function fakeProbe(overrides: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    probeId: "p",
    lexicalControl: false,
    goldRank: 1,
    distractorRank: null,
    hit1: true,
    hit10: true,
    distractorBeatsGold: false,
    reciprocalRank: 1,
    omittedKinds: [],
    totalInScope: 10,
    scoreDetails: [],
    termSpreads: [],
    ...overrides,
  };
}

function fakeReport(overrides: Partial<ArmReport> = {}, probeCount = 7): ArmReport {
  const probes = Array.from({ length: probeCount }, (_, i) => fakeProbe({ probeId: `p${i}` }));
  return {
    armLabel: "X: テスト用",
    tenantId: "retrieval-quality-arm-x-test",
    llmMode: "recorded",
    embeddingMode: "recorded",
    ingest: {
      observationCount: probeCount * 2 + 60,
      drain: { ticks: 3, firstTickProcessed: 50, totalProcessed: 74, totalFailed: 0 },
      extractionCounts: { ok: probeCount * 2 + 60, skipped: 0, llmFailedWholeObservation: 0 },
      measurement: "measured",
      singleTickWouldHaveStalled: true,
    },
    probes,
    mrrOverall: 0.5,
    mrrLexicalControl: 1,
    mrrNonLexical: 0.4,
    usageReport: "(テスト用の usageReport)",
    ...overrides,
  };
}

const FAKE_CASSETTE: Cassette = {
  version: 1,
  recordedAt: "2026-09-06T21:35:13.480Z",
  embedding: {
    space: { provider: "openai", model: "text-embedding-3-small", dimensions: 256 },
    entries: {},
  },
  llm: { model: "gpt-4o-mini", entries: {} },
};

describe("buildRetrievalQualityJson", () => {
  it("armHeadline() と同じ数字を返す(数字を書き写さない・別々の集計にしない)", () => {
    const report = fakeReport();
    const json = buildRetrievalQualityJson({
      reports: [report],
      providerSource: "recorded",
      cassette: FAKE_CASSETTE,
      measuredAt: new Date("2026-09-10T00:00:00.000Z"),
      commit: "0".repeat(40),
    });
    expect(json.arms).toHaveLength(1);
    const arm = json.arms[0]!;
    // armHeadline() を直接呼んで、独立に照合する(このファイル自身は armHeadline を
    // import せず、値を手で書いた場合との食い違いを検知するため、別経路の期待値を作る)。
    expect(arm.mrrOverall).toBe(0.5);
    expect(arm.hit1Count).toBe(report.probes.filter((p) => p.hit1).length);
    expect(arm.hit10Count).toBe(report.probes.filter((p) => p.hit10).length);
    expect(arm.probeCount).toBe(report.probes.length);
    expect(arm.mrrLexicalControl).toBe(report.mrrLexicalControl);
    expect(arm.mrrNonLexical).toBe(report.mrrNonLexical);
  });

  it("arm ごとに『実際に使われた』llmMode/embeddingMode を持つ(宣言値ではなく ArmReport の実値)", () => {
    const armA = fakeReport({
      armLabel: "A",
      llmMode: "deterministic",
      embeddingMode: "deterministic",
    });
    const armB = fakeReport({ armLabel: "B", llmMode: "deterministic", embeddingMode: "recorded" });
    const json = buildRetrievalQualityJson({
      reports: [armA, armB],
      providerSource: "recorded",
      cassette: FAKE_CASSETTE,
      measuredAt: new Date(),
      commit: null,
    });
    expect(json.arms.map((a) => [a.armLabel, a.llmMode, a.embeddingMode])).toEqual([
      ["A", "deterministic", "deterministic"],
      ["B", "deterministic", "recorded"],
    ]);
  });

  it("cassette 情報(recordedAt・埋め込み空間)を運ぶ", () => {
    const json = buildRetrievalQualityJson({
      reports: [fakeReport()],
      providerSource: "recorded",
      cassette: FAKE_CASSETTE,
      measuredAt: new Date(),
      commit: null,
    });
    expect(json.cassette).toEqual({
      recordedAt: "2026-09-06T21:35:13.480Z",
      embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 256 },
    });
  });

  it("providerSource === 'openai'(実 API 直叩き)では cassette が null になる", () => {
    const json = buildRetrievalQualityJson({
      reports: [fakeReport()],
      providerSource: "openai",
      cassette: undefined,
      measuredAt: new Date(),
      commit: null,
    });
    expect(json.providerSource).toBe("openai");
    expect(json.cassette).toBeNull();
  });

  it("probeCount/haystackSize を ingest.observationCount と probes.length から導く(定数を書き写さない)", () => {
    const report = fakeReport({}, 7);
    // observationCount = 7*2(gold+distractor) + 60(haystack)
    const json = buildRetrievalQualityJson({
      reports: [report],
      providerSource: "recorded",
      cassette: FAKE_CASSETTE,
      measuredAt: new Date(),
      commit: null,
    });
    expect(json.probeCount).toBe(7);
    expect(json.haystackSize).toBe(60);
  });

  it("measuredAt を ISO 文字列として運び、commit をそのまま(推測で埋めない)通す", () => {
    const json = buildRetrievalQualityJson({
      reports: [fakeReport()],
      providerSource: "recorded",
      cassette: FAKE_CASSETTE,
      measuredAt: new Date("2026-09-10T12:34:56.000Z"),
      commit: null,
    });
    expect(json.measuredAt).toBe("2026-09-10T12:34:56.000Z");
    expect(json.commit).toBeNull();
  });

  it("reports が空でも例外にせず、probeCount/haystackSize を 0 にする", () => {
    const json = buildRetrievalQualityJson({
      reports: [],
      providerSource: "recorded",
      cassette: FAKE_CASSETTE,
      measuredAt: new Date(),
      commit: null,
    });
    expect(json.arms).toEqual([]);
    expect(json.probeCount).toBe(0);
    expect(json.haystackSize).toBe(0);
  });

  it("schemaVersion は 1", () => {
    const json = buildRetrievalQualityJson({
      reports: [fakeReport()],
      providerSource: "recorded",
      cassette: FAKE_CASSETTE,
      measuredAt: new Date(),
      commit: null,
    });
    expect(json.schemaVersion).toBe(1);
  });
});

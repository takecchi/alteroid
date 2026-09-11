import { describe, expect, it } from "vitest";
import {
  buildDegenerateShareSection,
  buildMinBudgetForGoldSection,
  buildSummaryMarkdown,
  computeMinBudgetForGold,
  diffRound,
  findDegenerateRecalledActiveShareRows,
  validateBaseline,
  validateMeasured,
} from "../consolidation-cost-summary-lib.mjs";

/**
 * `consolidation-cost-summary-lib.mjs`(純関数の側)の歯。DB を要求しない
 * ——`retrieval-quality-summary-lib.test.mjs`/`identifier-probe-summary-lib.test.mjs`
 * と同じ分担・同じ理由(ADR 0088 / Issue #136)。
 *
 * ⛔ `examples/chat/consolidation-baseline.json` はまだコミットされていない
 * (マネージャーが実測値で作る)。ここで使う measured/baseline はすべて
 * この歯の中で組み立てたインライン fixture である。
 */

function makeProbe(overrides = {}) {
  return {
    probeId: "color",
    carriedCount: 2,
    carriedDigestTokens: 10,
    usageChars: 100,
    usageEstimatedTokens: 40,
    usageIndexChars: 10,
    totalInScope: 20,
    goldRank: 1,
    recalledActiveShare: 0.2,
    omittedKinds: [],
    budgetExceeded: false,
    ...overrides,
  };
}

function makeMean(overrides = {}) {
  return {
    carriedCount: 2,
    carriedDigestTokens: 10,
    usageChars: 100,
    usageEstimatedTokens: 40,
    usageIndexChars: 10,
    totalInScope: 20,
    recalledActiveShare: 0.2,
    goldRank: 1,
    goldRankExcludedCount: 0,
    ...overrides,
  };
}

function makeStore(overrides = {}) {
  return {
    activeCount: 10,
    supersededCount: 0,
    activeContentChars: 500,
    activeContentTokens: 120,
    activeDigestChars: 200,
    activeDigestTokens: 60,
    allContentChars: 500,
    ...overrides,
  };
}

function makeConsolidation(overrides = {}) {
  return {
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
    ...overrides,
  };
}

/** measured 側(probes 配列あり)の round。 */
function makeRound(overrides = {}) {
  return {
    round: 0,
    consolidation: null,
    store: makeStore(),
    recall: {
      unbudgeted: {
        probes: [makeProbe()],
        mean: makeMean(),
      },
      budgeted: [{ budgetTokens: 32, probes: [makeProbe()], mean: makeMean() }],
    },
    ...overrides,
  };
}

/** 基準値側(probes 配列を持たない軽量な round。validateBaseline はこれを要求しない)。 */
function makeBaselineRound(overrides = {}) {
  return {
    round: 0,
    consolidation: null,
    store: makeStore(),
    recall: {
      unbudgeted: { mean: makeMean() },
      budgeted: [{ budgetTokens: 32, mean: makeMean() }],
    },
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: "2026-09-10T00:00:00.000Z",
    commit: "0".repeat(40),
    llmMode: "deterministic",
    embeddingMode: "local",
    embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
    probeCount: 1,
    haystackSize: 20,
    groupSize: 5,
    budgetLadder: [32],
    recallLimit: 50,
    stoppedAfterRound: 0,
    stopReason: "completed_all_rounds",
    rounds: [makeRound()],
    ...overrides,
  };
}

function makeBaseline(overrides = {}) {
  return {
    ...makeMeasured(overrides),
    rounds: overrides.rounds ?? [makeBaselineRound()],
  };
}

describe("validateMeasured", () => {
  it("正しい形は ok:true を返す", () => {
    expect(validateMeasured(makeMeasured()).ok).toBe(true);
  });

  it("オブジェクトでなければ落ちる", () => {
    expect(validateMeasured(null).ok).toBe(false);
    expect(validateMeasured("x").ok).toBe(false);
    expect(validateMeasured(42).ok).toBe(false);
  });

  it("status が不明な値なら落ちる", () => {
    const result = validateMeasured(makeMeasured({ status: "bogus" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("status");
  });

  describe("status: weights_unavailable", () => {
    it("detail が文字列であれば ok:true(メトリクスの欄を要求しない)", () => {
      const result = validateMeasured({ status: "weights_unavailable", detail: "network error" });
      expect(result.ok).toBe(true);
    });

    it("detail が無い、または空なら落ちる", () => {
      expect(validateMeasured({ status: "weights_unavailable" }).ok).toBe(false);
      expect(validateMeasured({ status: "weights_unavailable", detail: "" }).ok).toBe(false);
    });
  });

  for (const field of [
    "llmMode",
    "embeddingMode",
    "stopReason",
    "probeCount",
    "haystackSize",
    "groupSize",
    "recallLimit",
    "stoppedAfterRound",
  ]) {
    it(`トップレベルの ${field} が欠けていれば名指しで落ちる`, () => {
      const measured = makeMeasured();
      delete measured[field];
      const result = validateMeasured(measured);
      expect(result.ok, `${field} が無いのに ok:true になった`).toBe(false);
      expect(result.error).toContain(field);
    });
  }

  it("budgetLadder が数値配列でなければ落ちる", () => {
    expect(validateMeasured(makeMeasured({ budgetLadder: ["32"] })).ok).toBe(false);
    expect(validateMeasured(makeMeasured({ budgetLadder: "32" })).ok).toBe(false);
  });

  for (const field of ["provider", "model", "dimensions"]) {
    it(`embeddingSpace.${field} が欠けていれば落ちる`, () => {
      const measured = makeMeasured();
      delete measured.embeddingSpace[field];
      const result = validateMeasured(measured);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(`embeddingSpace.${field}`);
    });
  }

  it("rounds が無い、または空配列なら落ちる", () => {
    expect(validateMeasured(makeMeasured({ rounds: [] })).ok).toBe(false);
    const noRounds = makeMeasured();
    delete noRounds.rounds;
    expect(validateMeasured(noRounds).ok).toBe(false);
  });

  for (const field of [
    "activeCount",
    "supersededCount",
    "activeContentChars",
    "activeContentTokens",
    "activeDigestChars",
    "activeDigestTokens",
    "allContentChars",
  ]) {
    it(`rounds[].store.${field} が欠けていれば名指しで落ちる`, () => {
      const round = makeRound();
      delete round.store[field];
      const result = validateMeasured(makeMeasured({ rounds: [round] }));
      expect(result.ok).toBe(false);
      expect(result.error).toContain(`rounds[0].store.${field}`);
    });
  }

  for (const field of [
    "carriedCount",
    "carriedDigestTokens",
    "usageChars",
    "usageEstimatedTokens",
    "usageIndexChars",
    "totalInScope",
    "recalledActiveShare",
  ]) {
    it(`rounds[].recall.unbudgeted.mean.${field} が欠けていれば名指しで落ちる`, () => {
      const round = makeRound();
      delete round.recall.unbudgeted.mean[field];
      const result = validateMeasured(makeMeasured({ rounds: [round] }));
      expect(result.ok).toBe(false);
      expect(result.error).toContain(`rounds[0].recall.unbudgeted.mean.${field}`);
    });
  }

  it("mean.goldRank が数値でも null でもなければ落ちる", () => {
    const round = makeRound();
    round.recall.unbudgeted.mean.goldRank = "1";
    const result = validateMeasured(makeMeasured({ rounds: [round] }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("goldRank");
  });

  it("mean.goldRankExcludedCount が数値でなければ落ちる", () => {
    const round = makeRound();
    round.recall.unbudgeted.mean.goldRankExcludedCount = null;
    const result = validateMeasured(makeMeasured({ rounds: [round] }));
    expect(result.ok).toBe(false);
  });

  it("recall.unbudgeted.probes が配列でなければ落ちる(measured は probes を要求する)", () => {
    const round = makeRound();
    delete round.recall.unbudgeted.probes;
    const result = validateMeasured(makeMeasured({ rounds: [round] }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rounds[0].recall.unbudgeted.probes");
  });

  it("recall.budgeted[].probes が配列でなければ落ちる(measured は probes を要求する)", () => {
    const round = makeRound();
    delete round.recall.budgeted[0].probes;
    const result = validateMeasured(makeMeasured({ rounds: [round] }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rounds[0].recall.budgeted[0].probes");
  });

  it("recall.budgeted[].budgetTokens が数値でなければ落ちる", () => {
    const round = makeRound();
    round.recall.budgeted[0].budgetTokens = "32";
    const result = validateMeasured(makeMeasured({ rounds: [round] }));
    expect(result.ok).toBe(false);
  });

  it("round.consolidation が null なら合格(round 0 の形)", () => {
    const result = validateMeasured(makeMeasured({ rounds: [makeRound({ consolidation: null })] }));
    expect(result.ok).toBe(true);
  });

  it("round.consolidation がオブジェクトでも null でもなければ落ちる", () => {
    const round = makeRound({ consolidation: "not an object" });
    const result = validateMeasured(makeMeasured({ rounds: [round] }));
    expect(result.ok).toBe(false);
  });

  for (const field of ["groups", "llmCalls", "newMemoryCount"]) {
    it(`consolidation.${field} が欠けていれば名指しで落ちる`, () => {
      const round = makeRound({ round: 1, consolidation: makeConsolidation() });
      delete round.consolidation[field];
      const result = validateMeasured(makeMeasured({ rounds: [round] }));
      expect(result.ok).toBe(false);
      expect(result.error).toContain(`consolidation.${field}`);
    });
  }

  for (const field of [
    "consolidated",
    "nothing_to_consolidate",
    "not_examined",
    "llm_failed",
    "dry_run",
  ]) {
    it(`consolidation.outcomes.${field} が欠けていれば名指しで落ちる`, () => {
      const round = makeRound({ round: 1, consolidation: makeConsolidation() });
      delete round.consolidation.outcomes[field];
      const result = validateMeasured(makeMeasured({ rounds: [round] }));
      expect(result.ok).toBe(false);
      expect(result.error).toContain(`consolidation.outcomes.${field}`);
    });
  }

  for (const field of ["ok", "pending", "failed"]) {
    it(`consolidation.embeddingStatus.${field} が欠けていれば名指しで落ちる`, () => {
      const round = makeRound({ round: 1, consolidation: makeConsolidation() });
      delete round.consolidation.embeddingStatus[field];
      const result = validateMeasured(makeMeasured({ rounds: [round] }));
      expect(result.ok).toBe(false);
      expect(result.error).toContain(`consolidation.embeddingStatus.${field}`);
    });
  }

  it("consolidation.embeddingFailureKinds が配列でなければ落ちる", () => {
    const round = makeRound({
      round: 1,
      consolidation: makeConsolidation({ embeddingFailureKinds: "unknown" }),
    });
    const result = validateMeasured(makeMeasured({ rounds: [round] }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("embeddingFailureKinds");
  });

  it("複数 round のうち1件だけ壊れていても検出する", () => {
    const good = makeRound({ round: 0 });
    const bad = makeRound({ round: 1 });
    delete bad.store.activeCount;
    const result = validateMeasured(makeMeasured({ rounds: [good, bad] }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rounds[1]");
  });
});

describe("validateBaseline", () => {
  it("正しい形(probes 無しの軽量な round)は ok:true を返す", () => {
    expect(validateBaseline(makeBaseline()).ok).toBe(true);
  });

  it("status が measured でなければ落ちる(基準値は常に measured のはず)", () => {
    expect(validateBaseline(makeBaseline({ status: "weights_unavailable" })).ok).toBe(false);
    const detail = { status: "weights_unavailable", detail: "x" };
    expect(validateBaseline(detail).ok).toBe(false);
  });

  it("オブジェクトでなければ落ちる", () => {
    expect(validateBaseline(null).ok).toBe(false);
  });

  it("rounds が無い、または空配列なら落ちる", () => {
    expect(validateBaseline(makeBaseline({ rounds: [] })).ok).toBe(false);
  });

  it("store の必須項目が欠けていれば落ちる(baseline も store は要求する)", () => {
    const round = makeBaselineRound();
    delete round.store.activeCount;
    const result = validateBaseline(makeBaseline({ rounds: [round] }));
    expect(result.ok).toBe(false);
  });
});

describe("computeMinBudgetForGold", () => {
  it("probe ごとに gold が載った最小の budgetTokens を返す", () => {
    const round = makeRound({
      recall: {
        unbudgeted: {
          probes: [makeProbe({ probeId: "a" }), makeProbe({ probeId: "b" })],
          mean: makeMean(),
        },
        budgeted: [
          {
            budgetTokens: 32,
            probes: [
              makeProbe({ probeId: "a", goldRank: null }),
              makeProbe({ probeId: "b", goldRank: 2 }),
            ],
            mean: makeMean(),
          },
          {
            budgetTokens: 64,
            probes: [
              makeProbe({ probeId: "a", goldRank: 1 }),
              makeProbe({ probeId: "b", goldRank: 1 }),
            ],
            mean: makeMean(),
          },
        ],
      },
    });
    const result = computeMinBudgetForGold(round);
    expect(result).toEqual([
      { probeId: "a", minBudgetForGold: 64 },
      { probeId: "b", minBudgetForGold: 32 },
    ]);
  });

  it("⛔ どの budget でも gold が載らなかった probe は 0 や最大値で埋めない(null のまま)", () => {
    const round = makeRound({
      recall: {
        unbudgeted: { probes: [makeProbe({ probeId: "never" })], mean: makeMean() },
        budgeted: [
          {
            budgetTokens: 32,
            probes: [makeProbe({ probeId: "never", goldRank: null })],
            mean: makeMean(),
          },
          {
            budgetTokens: 512,
            probes: [makeProbe({ probeId: "never", goldRank: null })],
            mean: makeMean(),
          },
        ],
      },
    });
    const result = computeMinBudgetForGold(round);
    expect(result).toEqual([{ probeId: "never", minBudgetForGold: null }]);
    // 0 でも 512(ラダーの最大値)でもない、ということを名指しで確認する。
    expect(result[0].minBudgetForGold).not.toBe(0);
    expect(result[0].minBudgetForGold).not.toBe(512);
  });
});

describe("buildMinBudgetForGoldSection", () => {
  it("「無し」を表に出し、無し件数を数える", () => {
    const round = makeRound({
      recall: {
        unbudgeted: {
          probes: [makeProbe({ probeId: "found" }), makeProbe({ probeId: "never" })],
          mean: makeMean(),
        },
        budgeted: [
          {
            budgetTokens: 32,
            probes: [
              makeProbe({ probeId: "found", goldRank: 1 }),
              makeProbe({ probeId: "never", goldRank: null }),
            ],
            mean: makeMean(),
          },
        ],
      },
    });
    const markdown = buildMinBudgetForGoldSection(makeMeasured({ rounds: [round] }));
    expect(markdown).toContain("(無し)");
    // ヘッダ行の直後、この1 round分のデータ行に無し件数 1 が出る。
    const dataRow = markdown.split("\n").find((line) => line.startsWith("| 0 |"));
    expect(dataRow).toBeDefined();
    expect(dataRow).toContain("| 1 |"); // 末尾セル(無し件数)
  });
});

describe("diffRound", () => {
  it("完全一致なら matches:true", () => {
    const round = makeRound();
    const result = diffRound(round, structuredClone(round));
    expect(result.matches).toBe(true);
    expect(result.fieldDiffs).toEqual([]);
  });

  it("基準値に対応する round が無ければ missingBaseline:true", () => {
    const result = diffRound(makeRound(), undefined);
    expect(result.matches).toBe(false);
    expect(result.missingBaseline).toBe(true);
  });

  it("store の値が違う項目だけを fieldDiffs に載せる", () => {
    const baseline = makeRound();
    const measured = makeRound();
    measured.store.activeCount = 999;
    const result = diffRound(measured, baseline);
    expect(result.matches).toBe(false);
    const diff = result.fieldDiffs.find((d) => d.field === "store.activeCount");
    expect(diff).toEqual({ field: "store.activeCount", baseline: 10, measured: 999 });
  });

  it("consolidation が片方だけ null なら相違として載る", () => {
    const baseline = makeRound({ round: 1, consolidation: null });
    const measured = makeRound({ round: 1, consolidation: makeConsolidation() });
    const result = diffRound(measured, baseline);
    expect(result.matches).toBe(false);
    expect(result.fieldDiffs.some((d) => d.field === "consolidation")).toBe(true);
  });

  it("consolidation の内訳が違えば個別のフィールドとして載る", () => {
    const baseline = makeRound({ round: 1, consolidation: makeConsolidation() });
    const measured = makeRound({
      round: 1,
      consolidation: makeConsolidation({ llmCalls: 99 }),
    });
    const result = diffRound(measured, baseline);
    expect(result.fieldDiffs.find((d) => d.field === "consolidation.llmCalls")).toEqual({
      field: "consolidation.llmCalls",
      baseline: 2,
      measured: 99,
    });
  });

  it("embeddingFailureKinds は集合として比べる(順序は無視する)", () => {
    const baseline = makeRound({
      round: 1,
      consolidation: makeConsolidation({ embeddingFailureKinds: ["a", "b"] }),
    });
    const measured = makeRound({
      round: 1,
      consolidation: makeConsolidation({ embeddingFailureKinds: ["b", "a"] }),
    });
    expect(diffRound(measured, baseline).matches).toBe(true);
  });

  it("embeddingFailureKinds の中身が違えば相違する", () => {
    const baseline = makeRound({
      round: 1,
      consolidation: makeConsolidation({ embeddingFailureKinds: ["a"] }),
    });
    const measured = makeRound({
      round: 1,
      consolidation: makeConsolidation({ embeddingFailureKinds: ["c"] }),
    });
    const result = diffRound(measured, baseline);
    expect(result.matches).toBe(false);
    expect(result.fieldDiffs.some((d) => d.field === "consolidation.embeddingFailureKinds")).toBe(
      true,
    );
  });

  it("mean の値が違う項目だけを fieldDiffs に載せる", () => {
    const baseline = makeRound();
    const measured = makeRound();
    measured.recall.unbudgeted.mean.goldRank = 5;
    const result = diffRound(measured, baseline);
    expect(
      result.fieldDiffs.find((d) => d.field === "recall.unbudgeted.mean.goldRank"),
    ).toBeDefined();
  });

  it("budgeted 段は budgetTokens で対応付ける(配列の並び順ではない)", () => {
    const baseline = makeRound({
      recall: {
        unbudgeted: { probes: [makeProbe()], mean: makeMean() },
        budgeted: [
          { budgetTokens: 32, probes: [makeProbe()], mean: makeMean() },
          { budgetTokens: 64, probes: [makeProbe()], mean: makeMean({ carriedCount: 3 }) },
        ],
      },
    });
    const measured = makeRound({
      recall: {
        unbudgeted: { probes: [makeProbe()], mean: makeMean() },
        // 順序を逆にしても一致することを見る。
        budgeted: [
          { budgetTokens: 64, probes: [makeProbe()], mean: makeMean({ carriedCount: 3 }) },
          { budgetTokens: 32, probes: [makeProbe()], mean: makeMean() },
        ],
      },
    });
    expect(diffRound(measured, baseline).matches).toBe(true);
  });

  it("測定側にのみ存在する budget 段は「基準値に無い」と載る", () => {
    const baseline = makeRound();
    const measured = makeRound({
      recall: {
        unbudgeted: { probes: [makeProbe()], mean: makeMean() },
        budgeted: [
          { budgetTokens: 32, probes: [makeProbe()], mean: makeMean() },
          { budgetTokens: 999, probes: [makeProbe()], mean: makeMean() },
        ],
      },
    });
    const result = diffRound(measured, baseline);
    expect(result.matches).toBe(false);
    const diff = result.fieldDiffs.find((d) => d.field === "recall.budgeted[budgetTokens=999]");
    expect(diff).toBeDefined();
  });
});

describe("findDegenerateRecalledActiveShareRows / buildDegenerateShareSection", () => {
  it("recalledActiveShare が全て低ければ該当なし", () => {
    const measured = makeMeasured();
    expect(findDegenerateRecalledActiveShareRows(measured)).toEqual([]);
    expect(buildDegenerateShareSection(measured)).toContain("該当なし");
  });

  it("⭐ budget 段の recalledActiveShare が 1.0 なら「退化」の行として検出する(実測で起きた形)", () => {
    const round = makeRound({
      round: 2,
      recall: {
        unbudgeted: { probes: [makeProbe()], mean: makeMean({ recalledActiveShare: 0.3 }) },
        budgeted: [
          {
            budgetTokens: 256,
            probes: [makeProbe()],
            mean: makeMean({ recalledActiveShare: 1.0 }),
          },
          {
            budgetTokens: 512,
            probes: [makeProbe()],
            mean: makeMean({ recalledActiveShare: 1.0 }),
          },
        ],
      },
    });
    const measured = makeMeasured({ rounds: [round] });
    const rows = findDegenerateRecalledActiveShareRows(measured);
    expect(rows).toEqual([
      { round: 2, label: "budget=256", recalledActiveShare: 1.0 },
      { round: 2, label: "budget=512", recalledActiveShare: 1.0 },
    ]);
    const section = buildDegenerateShareSection(measured);
    expect(section).not.toContain("該当なし");
    expect(section).toContain("budget=256");
    expect(section).toContain("退化");
    expect(section).toContain("比較不能");
  });

  it("unbudgeted 側の recalledActiveShare が 1.0 でも検出する", () => {
    const round = makeRound({
      recall: {
        unbudgeted: { probes: [makeProbe()], mean: makeMean({ recalledActiveShare: 1.0 }) },
        budgeted: [
          { budgetTokens: 32, probes: [makeProbe()], mean: makeMean({ recalledActiveShare: 0.1 }) },
        ],
      },
    });
    const rows = findDegenerateRecalledActiveShareRows(makeMeasured({ rounds: [round] }));
    expect(rows).toEqual([{ round: 0, label: "unbudgeted", recalledActiveShare: 1.0 }]);
  });

  it("0.999 未満(しきい値未満)は退化として扱わない", () => {
    const round = makeRound({
      recall: {
        unbudgeted: { probes: [makeProbe()], mean: makeMean({ recalledActiveShare: 0.99 }) },
        budgeted: [
          {
            budgetTokens: 32,
            probes: [makeProbe()],
            mean: makeMean({ recalledActiveShare: 0.99 }),
          },
        ],
      },
    });
    expect(findDegenerateRecalledActiveShareRows(makeMeasured({ rounds: [round] }))).toEqual([]);
  });
});

describe("buildSummaryMarkdown", () => {
  it("baseline を省略すると差分節そのものを出さない", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).not.toContain("基準値との差分");
  });

  it("ADR 0088 §3-3: baseline と一致すれば1行で黙る(表を展開しない)", () => {
    const measured = makeMeasured();
    const markdown = buildSummaryMarkdown({ measured, baseline: makeBaseline() });
    expect(markdown).toContain("基準値との差分");
    expect(markdown).toContain("✅ 一致(差分なし)。");
    expect(markdown).not.toContain("| 項目 | 基準値 | 実測 |");
  });

  it("ADR 0088 §3-3: baseline と相違すれば表として展開する", () => {
    const measured = makeMeasured();
    const round = makeBaselineRound();
    round.store.activeCount = 1;
    const baseline = makeBaseline({ rounds: [round] });
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("相違した箇所がある");
    expect(markdown).toContain("| 項目 | 基準値 | 実測 |");
    expect(markdown).toContain("store.activeCount");
  });

  it("gold を載せるのに要った最小予算の節が出る", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("gold を載せるのに要った最小予算");
  });

  it("退化検出の節が出る", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("退化検出");
  });

  it("🔴 status: weights_unavailable のときはメトリクスの表も基準値比較も一切出さない", () => {
    const measured = { status: "weights_unavailable", detail: "network error: HF 503" };
    const markdown = buildSummaryMarkdown({ measured, baseline: makeBaseline() });
    expect(markdown).toContain("重みを取得できなかったので、値は測っていない");
    expect(markdown).toContain("network error: HF 503");
    expect(markdown).not.toContain("基準値との差分");
    expect(markdown).not.toContain("一致");
    expect(markdown).not.toContain("相違");
    expect(markdown).not.toContain("gold を載せるのに要った最小予算");
    expect(markdown).not.toContain("退化検出");
  });

  it("⭐ 3つの読み方の注意書きをすべて含む", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    // (1) LLM は擬似であり、統合結果の content/digest の長さは擬似物の性質である。
    expect(markdown).toContain("擬似物の性質である");
    expect(markdown).toContain("content");
    expect(markdown).toContain("digest");
    // (2) 標本は probe 7件、ここから率を主張しない(ADR 0033 §3)。
    expect(markdown).toContain("probe 7件");
    // (3) 件数が減ったこと自体は良し悪しを言わない。
    expect(markdown).toContain("件数が減ったこと自体は良し悪しを言わない");
  });
});

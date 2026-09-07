import { describe, expect, it } from "vitest";
import type { ScoreBreakdown } from "@mnemora/core";
import {
  TIME_PROBES,
  buildTimeTermConversation,
  newerExternalId,
  olderExternalId,
} from "../time-term-probe-set.js";
import type { PairMember } from "../time-term-arm.js";
import { TIE_EPSILON, classifyPairOutcome } from "../time-term-arm.js";

/**
 * 純関数だけを検査する(PR 本文)。**⛔ 品質の数値は assert しない**——DB も provider も
 * 使わない歯であり、`buildTimeTermConversation`/`TIME_PROBES`/`classifyPairOutcome`/
 * `TIE_EPSILON` という「仕組み」だけを検査する。実測値の検査は
 * `time-term.postgres.test.ts`(本物の Postgres)の側に置く。
 */

describe("buildTimeTermConversation", () => {
  it("newer/older の text は厳密に等しい(ペアの本文を同一にすることがこの arm の要)", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    for (const probe of TIME_PROBES) {
      const [newer, older] = buildTimeTermConversation(probe, now);
      expect(newer!.text).toBe(older!.text);
      expect(newer!.text).toBe(probe.fact);
    }
  });

  it("externalId は newer/older で違う(externalId 規約どおり)", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    const [newer, older] = buildTimeTermConversation(TIME_PROBES[0]!, now);
    expect(newer!.externalId).toBe(newerExternalId(TIME_PROBES[0]!.id));
    expect(older!.externalId).toBe(olderExternalId(TIME_PROBES[0]!.id));
    expect(newer!.externalId).not.toBe(older!.externalId);
  });

  it("occurredAt は now から daysAgo 日ぶんだけ正しく引かれる", () => {
    const now = new Date("2026-09-08T12:00:00.000Z");
    const probe = TIME_PROBES.find((p) => p.id === "realistic")!;
    const [newer, older] = buildTimeTermConversation(probe, now);
    expect(newer!.occurredAt).toEqual(new Date("2026-09-07T12:00:00.000Z"));
    expect(older!.occurredAt).toEqual(new Date("2026-09-04T12:00:00.000Z"));
  });

  it("daysAgo が null の probe では occurredAt も null になる(渡さない、と同値)", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    const probe = TIME_PROBES.find((p) => p.id === "absent")!;
    const [newer, older] = buildTimeTermConversation(probe, now);
    expect(newer!.occurredAt).toBeNull();
    expect(older!.occurredAt).toBeNull();
  });

  it("same-occurred-at probe は newer/older の occurredAt が一致する(同じ日数前)", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    const probe = TIME_PROBES.find((p) => p.id === "same-occurred-at")!;
    const [newer, older] = buildTimeTermConversation(probe, now);
    expect(newer!.occurredAt).toEqual(older!.occurredAt);
    expect(newer!.occurredAt).not.toBeNull();
  });

  it("recordedDaysAgo を持たない既存5 probe では recordedAt が null のまま(いままでと同じ挙動)", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    const existingIds = ["half-life", "realistic", "same-occurred-at", "absent", "far-past"];
    for (const id of existingIds) {
      const probe = TIME_PROBES.find((p) => p.id === id)!;
      const [newer, older] = buildTimeTermConversation(probe, now);
      expect(newer!.recordedAt).toBeNull();
      expect(older!.recordedAt).toBeNull();
    }
  });

  it("decay-* probe では recordedAt が recordedDaysAgo 日ぶんだけ正しく引かれる", () => {
    const now = new Date("2026-09-08T12:00:00.000Z");
    const probe = TIME_PROBES.find((p) => p.id === "decay-realistic")!;
    const [newer, older] = buildTimeTermConversation(probe, now);
    expect(newer!.recordedAt).toEqual(new Date("2026-09-07T12:00:00.000Z"));
    expect(older!.recordedAt).toEqual(new Date("2026-09-04T12:00:00.000Z"));
    // occurredAt は newer/older で揃えてある(decay だけを動かすための要)。
    expect(newer!.occurredAt).toEqual(older!.occurredAt);
    expect(newer!.occurredAt).not.toBeNull();
  });

  it("decay-same-recorded-at probe は newer/older の recordedAt が一致する", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    const probe = TIME_PROBES.find((p) => p.id === "decay-same-recorded-at")!;
    const [newer, older] = buildTimeTermConversation(probe, now);
    expect(newer!.recordedAt).toEqual(older!.recordedAt);
    expect(newer!.recordedAt).not.toBeNull();
  });
});

describe("TIME_PROBES", () => {
  it("id が一意である", () => {
    const ids = TIME_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("fact の先頭40字が probe 間で一意である(DeterministicLLMProvider が digest を40字で切るため)", () => {
    const prefixes = TIME_PROBES.map((p) => p.fact.slice(0, 40));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("fact と query が空でない", () => {
    for (const probe of TIME_PROBES) {
      expect(probe.fact.length).toBeGreaterThan(0);
      expect(probe.query.length).toBeGreaterThan(0);
    }
  });

  it("既存5件の probe が、PR 本文の表どおりの daysAgo を持つ(recordedDaysAgo は無い)", () => {
    const byId = Object.fromEntries(TIME_PROBES.map((p) => [p.id, p]));
    expect(byId["half-life"]).toMatchObject({ newerDaysAgo: 0, olderDaysAgo: 30 });
    expect(byId["realistic"]).toMatchObject({ newerDaysAgo: 1, olderDaysAgo: 4 });
    expect(byId["same-occurred-at"]).toMatchObject({ newerDaysAgo: 7, olderDaysAgo: 7 });
    expect(byId["absent"]).toMatchObject({ newerDaysAgo: null, olderDaysAgo: null });
    expect(byId["far-past"]).toMatchObject({ newerDaysAgo: 1, olderDaysAgo: 365 });
    for (const id of ["half-life", "realistic", "same-occurred-at", "absent", "far-past"]) {
      expect(byId[id]!.newerRecordedDaysAgo).toBeUndefined();
      expect(byId[id]!.olderRecordedDaysAgo).toBeUndefined();
    }
  });

  it("decay-* の3件が、PR 本文の表どおりの occurredAt(揃えてある)/recordedDaysAgo を持つ", () => {
    const byId = Object.fromEntries(TIME_PROBES.map((p) => [p.id, p]));
    expect(byId["decay-half-life"]).toMatchObject({
      newerDaysAgo: 7,
      olderDaysAgo: 7,
      newerRecordedDaysAgo: 0,
      olderRecordedDaysAgo: 30,
    });
    expect(byId["decay-realistic"]).toMatchObject({
      newerDaysAgo: 7,
      olderDaysAgo: 7,
      newerRecordedDaysAgo: 1,
      olderRecordedDaysAgo: 4,
    });
    expect(byId["decay-same-recorded-at"]).toMatchObject({
      newerDaysAgo: 7,
      olderDaysAgo: 7,
      newerRecordedDaysAgo: 1,
      olderRecordedDaysAgo: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// classifyPairOutcome
// ---------------------------------------------------------------------------

function member(overrides: Partial<PairMember> & { total: number }): PairMember {
  const score: ScoreBreakdown = {
    decay: 1,
    tagMatch: 1,
    freshness: 1,
    strength: 1,
    total: overrides.total,
  };
  return {
    rank: overrides.rank ?? 1,
    digest: overrides.digest ?? "digest",
    score,
  };
}

describe("classifyPairOutcome", () => {
  it("両方 null なら neither-returned", () => {
    expect(classifyPairOutcome(null, null)).toBe("neither-returned");
  });

  it("newer が null なら newer-not-returned", () => {
    expect(classifyPairOutcome(null, member({ rank: 1, total: 0.5 }))).toBe("newer-not-returned");
  });

  it("older が null なら older-not-returned", () => {
    expect(classifyPairOutcome(member({ rank: 1, total: 0.5 }), null)).toBe("older-not-returned");
  });

  it("pairCollapsed を渡されたら、他のどの分類よりも先に collapsed になる", () => {
    // ペアが潰れたときに実際に現れる形は「片方が返ってこない」であり、`rank` の
    // 比較では検出できない(`classifyPairOutcome` の docstring)。⟹ 呼び出し側が
    // スコープ内総数から判定して渡す。**その判定が `older-not-returned` に
    // 読み替えられていないこと**をここで確かめる。
    const newer = member({ rank: 1, total: 0.9 });
    expect(classifyPairOutcome(newer, null, { pairCollapsed: true })).toBe("collapsed");
    expect(classifyPairOutcome(newer, null, { pairCollapsed: false })).toBe("older-not-returned");
    expect(classifyPairOutcome(null, null, { pairCollapsed: true })).toBe("collapsed");
  });

  it("total 差がちょうど tieEpsilon なら tied(境界は「以下」)", () => {
    const newer = member({ rank: 1, total: 0.5001 });
    const older = member({ rank: 2, total: 0.5 });
    expect(classifyPairOutcome(newer, older, { tieEpsilon: 1e-4 })).toBe("tied");
  });

  it("total 差が tieEpsilon をわずかに超えたら tied ではない", () => {
    const newer = member({ rank: 1, total: 0.50011 });
    const older = member({ rank: 2, total: 0.5 });
    expect(classifyPairOutcome(newer, older, { tieEpsilon: 1e-4 })).toBe("newer-ranked-higher");
  });

  it("newer の rank が小さければ newer-ranked-higher", () => {
    const newer = member({ rank: 1, total: 0.9 });
    const older = member({ rank: 2, total: 0.5 });
    expect(classifyPairOutcome(newer, older)).toBe("newer-ranked-higher");
  });

  it("older の rank が小さければ older-ranked-higher", () => {
    const newer = member({ rank: 2, total: 0.5 });
    const older = member({ rank: 1, total: 0.9 });
    expect(classifyPairOutcome(newer, older)).toBe("older-ranked-higher");
  });

  it("options を省略すると既定の TIE_EPSILON が使われる", () => {
    const newer = member({ rank: 1, total: 0.5 + TIE_EPSILON });
    const older = member({ rank: 2, total: 0.5 });
    expect(classifyPairOutcome(newer, older)).toBe("tied");
  });
});

describe("TIE_EPSILON", () => {
  it("realistic probe が予測する freshness 差(約 0.0655)より十分小さい", () => {
    // 0.5**(1/30) - 0.5**(4/30) ≈ 0.0654374798760291(PR 本文の数値)。
    // ここでの「予測」は検査対象の実装と同じ式を使わないよう、この歯自身では
    // 計算し直さず定数として書く(同義反復を避けるため)。
    const predictedRealisticFreshnessGap = 0.0654374798760291;
    expect(TIE_EPSILON).toBeLessThan(predictedRealisticFreshnessGap / 100);
  });
});

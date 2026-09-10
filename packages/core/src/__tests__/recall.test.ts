import { describe, expect, it } from "vitest";
import {
  GroupCountSchema,
  IndexBandSchema,
  OmissionSchema,
  RecallQuerySchema,
  RecalledMemorySchema,
  RecallResultSchema,
  RecallUsageSchema,
} from "../recall.js";

describe("OmissionSchema — 10 の kind すべて", () => {
  // ⚠ 題は以前「7つの kind すべて」だった。ann_unreached（ADR 0026）が入った時点で 8 に
  // なっていたのに直っておらず、score_not_comparable（ADR 0044）で 9、
  // unit_assembly_dropped（ADR 0043）で 10 になる。**名乗りは実測に合わせる。**
  it("accepts 'stage_skipped'", () => {
    const result = OmissionSchema.safeParse({
      kind: "stage_skipped",
      stage: "candidate_generation",
      reason: "embedding_provider_unavailable",
    });
    expect(result.success).toBe(true);
  });

  it("rejects 'stage_skipped' の reason が未知の値", () => {
    const result = OmissionSchema.safeParse({
      kind: "stage_skipped",
      stage: "candidate_generation",
      reason: "something_else",
    });
    expect(result.success).toBe(false);
  });

  it("accepts 'filtered'", () => {
    const result = OmissionSchema.safeParse({
      kind: "filtered",
      condition: "period",
      count: 3,
      countKind: "exact",
    });
    expect(result.success).toBe(true);
  });

  it("rejects 'filtered' の count が負数", () => {
    const result = OmissionSchema.safeParse({
      kind: "filtered",
      condition: "period",
      count: -1,
      countKind: "exact",
    });
    expect(result.success).toBe(false);
  });

  it("accepts 'below_threshold'（nearMisses 省略可）", () => {
    const result = OmissionSchema.safeParse({
      kind: "below_threshold",
      count: 2,
      countKind: "exact",
    });
    expect(result.success).toBe(true);
  });

  it("accepts 'below_threshold'（nearMisses あり）", () => {
    const result = OmissionSchema.safeParse({
      kind: "below_threshold",
      count: 2,
      countKind: "exact",
      nearMisses: [{ memoryId: "m1", score: 0.4 }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects 'below_threshold' の nearMisses の要素が不正", () => {
    const result = OmissionSchema.safeParse({
      kind: "below_threshold",
      count: 2,
      countKind: "exact",
      nearMisses: [{ memoryId: "m1" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts 'over_limit'", () => {
    const result = OmissionSchema.safeParse({
      kind: "over_limit",
      count: 5,
      countKind: "exact",
    });
    expect(result.success).toBe(true);
  });

  it("rejects 'over_limit' が countKind を欠く", () => {
    const result = OmissionSchema.safeParse({ kind: "over_limit", count: 5 });
    expect(result.success).toBe(false);
  });

  it("accepts 'budget_dropped'", () => {
    const result = OmissionSchema.safeParse({
      kind: "budget_dropped",
      count: 1,
      countKind: "lower_bound",
    });
    expect(result.success).toBe(true);
  });

  it("rejects 'budget_dropped' の countKind が未知の値", () => {
    const result = OmissionSchema.safeParse({
      kind: "budget_dropped",
      count: 1,
      countKind: "approximate",
    });
    expect(result.success).toBe(false);
  });

  it("rejects 'not_indexed' without reason（理由を潰した形は受け付けない）", () => {
    const result = OmissionSchema.safeParse({
      kind: "not_indexed",
      count: 4,
      countKind: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("accepts 'not_indexed'", () => {
    const result = OmissionSchema.safeParse({
      kind: "not_indexed",
      reason: "failed",
      count: 4,
      countKind: "unknown",
    });
    expect(result.success).toBe(true);
  });

  it("rejects 'not_indexed' の count が非整数", () => {
    const result = OmissionSchema.safeParse({
      kind: "not_indexed",
      count: 1.5,
      countKind: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("accepts 'ann_truncated'（countKind は必ず 'unknown'）", () => {
    const result = OmissionSchema.safeParse({
      kind: "ann_truncated",
      countKind: "unknown",
      certainty: "loss_possible",
      safetyRatio: 0.5,
      assumptions: ["decay <= 1: ...", "strength <= 1: ..."],
    });
    expect(result.success).toBe(true);
  });

  // ADR 0069: certainty は**必須**である。省略できると「損したかもしれない」と
  // 「判定できなかった」が同じ形で通ってしまい、この決定の芯が消える。
  it("rejects 'ann_truncated' の certainty 欠落（ADR 0069）", () => {
    const result = OmissionSchema.safeParse({ kind: "ann_truncated", countKind: "unknown" });
    expect(result.success).toBe(false);
  });

  // **'provably_safe' は omission としては存在しない**——証明できたら札は積まれない
  // （沈黙は「値」ではなく「不在」で表す。ADR 0069）。
  it("rejects 'ann_truncated' の certainty が 'provably_safe'（ADR 0069）", () => {
    const result = OmissionSchema.safeParse({
      kind: "ann_truncated",
      countKind: "unknown",
      certainty: "provably_safe",
    });
    expect(result.success).toBe(false);
  });

  it("rejects 'ann_truncated' の countKind が 'exact'（型で 'unknown' 固定のため）", () => {
    const result = OmissionSchema.safeParse({
      kind: "ann_truncated",
      countKind: "exact",
      certainty: "loss_possible",
    });
    expect(result.success).toBe(false);
  });

  it("rejects 未知の kind", () => {
    const result = OmissionSchema.safeParse({ kind: "vanished" });
    expect(result.success).toBe(false);
  });
});

describe("OmissionSchema — score_not_comparable（ADR 0044）", () => {
  it("accepts 'score_not_comparable'", () => {
    const result = OmissionSchema.safeParse({
      kind: "score_not_comparable",
      count: 1,
      countKind: "exact",
    });
    expect(result.success).toBe(true);
  });

  it("rejects count を欠く score_not_comparable（件数は必ず持つ）", () => {
    // ann_unreached（ADR 0026）は「原理的に数えられない」ので件数を持たないが、
    // こちらは段2が触った候補を数え上げるだけなので、必ず持つ。
    const result = OmissionSchema.safeParse({ kind: "score_not_comparable", countKind: "exact" });
    expect(result.success).toBe(false);
  });

  it("rejects countKind を欠く score_not_comparable（名乗りなしで件数を出さない）", () => {
    const result = OmissionSchema.safeParse({ kind: "score_not_comparable", count: 1 });
    expect(result.success).toBe(false);
  });

  it("accepts countKind: 'unknown'（三分割が網羅でなくなったときに落ちる先）", () => {
    const result = OmissionSchema.safeParse({
      kind: "score_not_comparable",
      count: 1,
      countKind: "unknown",
    });
    expect(result.success).toBe(true);
  });
});

describe("OmissionSchema — unit_assembly_dropped（ADR 0043）", () => {
  it("accepts 'unit_assembly_dropped'", () => {
    const result = OmissionSchema.safeParse({
      kind: "unit_assembly_dropped",
      count: 1,
      countKind: "lower_bound",
    });
    expect(result.success).toBe(true);
  });

  it("rejects count: 0（消えていないのに「消えた」と名乗らない）", () => {
    // ⚠ 他の件数つき omission は nonnegative だが、この欄は positive にしてある——
    //    0件の消失を報告することは、この欄の意味（黙らせない）と矛盾する。
    const result = OmissionSchema.safeParse({
      kind: "unit_assembly_dropped",
      count: 0,
      countKind: "lower_bound",
    });
    expect(result.success).toBe(false);
  });

  it("rejects count を欠く unit_assembly_dropped", () => {
    const result = OmissionSchema.safeParse({
      kind: "unit_assembly_dropped",
      countKind: "lower_bound",
    });
    expect(result.success).toBe(false);
  });
});

describe("GroupCountSchema — D12: key は string | null", () => {
  it("accepts key が文字列", () => {
    const result = GroupCountSchema.safeParse({
      axis: "subject",
      key: "project/mnemora",
      count: 10,
      countKind: "exact",
    });
    expect(result.success).toBe(true);
  });

  it("accepts key が null（subject_id IS NULL の群）", () => {
    const result = GroupCountSchema.safeParse({
      axis: "subject",
      key: null,
      count: 3,
      countKind: "exact",
    });
    expect(result.success).toBe(true);
  });

  it("rejects key が undefined（省略不可。null を明示する必要がある）", () => {
    const result = GroupCountSchema.safeParse({
      axis: "subject",
      count: 3,
      countKind: "exact",
    });
    expect(result.success).toBe(false);
  });
});

describe("IndexBandSchema", () => {
  it("accepts digestBand 省略（Phase 1 は常に undefined）", () => {
    const result = IndexBandSchema.safeParse({
      groups: [],
      totalInScope: 0,
      countKind: "exact",
    });
    expect(result.success).toBe(true);
  });

  it("accepts digestBand が指定された場合", () => {
    const result = IndexBandSchema.safeParse({
      groups: [],
      totalInScope: 1,
      countKind: "exact",
      digestBand: [{ memoryId: "m1", digest: "d" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts digestBand の1件に truncated: true が付いた場合", () => {
    const result = IndexBandSchema.safeParse({
      groups: [],
      totalInScope: 1,
      countKind: "exact",
      digestBand: [{ memoryId: "m1", digest: "d", truncated: true }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts digestBandCoverage が limitedBy 無しで指定された場合（＝どの上限にも当たらなかった）", () => {
    const result = IndexBandSchema.safeParse({
      groups: [],
      totalInScope: 1,
      countKind: "exact",
      digestBand: [{ memoryId: "m1", digest: "d" }],
      digestBandCoverage: { shown: 1, eligible: 1, countKind: "exact" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts digestBandCoverage.limitedBy の3値すべて", () => {
    for (const limitedBy of ["entry_limit", "char_budget", "both"] as const) {
      const result = IndexBandSchema.safeParse({
        groups: [],
        totalInScope: 5,
        countKind: "exact",
        digestBand: [],
        digestBandCoverage: { shown: 0, eligible: 5, countKind: "exact", limitedBy },
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects digestBandCoverage.limitedBy が未知の値", () => {
    const result = IndexBandSchema.safeParse({
      groups: [],
      totalInScope: 1,
      countKind: "exact",
      digestBandCoverage: {
        shown: 0,
        eligible: 1,
        countKind: "exact",
        limitedBy: "something_else",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("RecallQuerySchema — D5: excludeProvenanceKinds", () => {
  it("accepts excludeProvenanceKinds を指定しない（既定で inferred を含める）", () => {
    const result = RecallQuerySchema.safeParse({ text: "hello" });
    expect(result.success).toBe(true);
  });

  it("accepts excludeProvenanceKinds: ['inferred']（推論を除外するオプション）", () => {
    const result = RecallQuerySchema.safeParse({
      text: "hello",
      excludeProvenanceKinds: ["inferred"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects excludeProvenanceKinds に未知の provenance kind", () => {
    const result = RecallQuerySchema.safeParse({
      excludeProvenanceKinds: ["fabricated"],
    });
    expect(result.success).toBe(false);
  });
});

describe("RecallQuerySchema — digestBandLimit（目次帯の件数上限。本 PR）", () => {
  it("accepts digestBandLimit を指定しない（既定 DEFAULT_DIGEST_BAND_LIMIT を使う）", () => {
    const result = RecallQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts digestBandLimit に正の整数", () => {
    const result = RecallQuerySchema.safeParse({ digestBandLimit: 100 });
    expect(result.success).toBe(true);
  });

  it("rejects digestBandLimit: 0 — 目次帯の保証を呼び出し側が消せないようにする（RecallQuery.limit と同じ作法）", () => {
    const result = RecallQuerySchema.safeParse({ digestBandLimit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects digestBandLimit に負の値", () => {
    const result = RecallQuerySchema.safeParse({ digestBandLimit: -5 });
    expect(result.success).toBe(false);
  });

  it("rejects digestBandLimit に非整数", () => {
    const result = RecallQuerySchema.safeParse({ digestBandLimit: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe("RecalledMemorySchema — provenanceKind（roadmap.md §5.5 のオーナー回答の条件）", () => {
  // 型（TypeScript）だけでなく schema（zod）でも必須にしてある。
  // 型は境界の外（HTTP・JSON）では効かないので、**片方だけでは
  // 「欄が抜けたまま既定値の顔で通る」経路が残る。**
  const base = {
    memoryId: "mem-1",
    digest: "digest",
    retrievedVia: "ann",
    score: { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 },
  };

  it("accepts provenanceKind: 'stated'（本人が述べた事実）", () => {
    const result = RecalledMemorySchema.safeParse({ ...base, provenanceKind: "stated" });
    expect(result.success).toBe(true);
  });

  it("accepts provenanceKind: 'inferred'（AI の推論。区別して返る）", () => {
    const result = RecalledMemorySchema.safeParse({ ...base, provenanceKind: "inferred" });
    expect(result.success).toBe(true);
  });

  it("rejects provenanceKind を欠く RecalledMemory（省略可能にしない）", () => {
    const result = RecalledMemorySchema.safeParse(base);
    expect(result.success).toBe(false);
  });

  it("rejects 未知の provenance kind", () => {
    const result = RecalledMemorySchema.safeParse({ ...base, provenanceKind: "fabricated" });
    expect(result.success).toBe(false);
  });
});

describe("RecallResultSchema", () => {
  it("accepts 0件の recall（index だけが在る、という形）", () => {
    const result = RecallResultSchema.safeParse({
      recallId: "rcl-1",
      memories: [],
      omitted: [{ kind: "filtered", condition: "period", count: 3, countKind: "exact" }],
      index: {
        groups: [{ axis: "subject", key: "project/mnemora", count: 412, countKind: "exact" }],
        totalInScope: 412,
        countKind: "exact",
      },
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 1 },
        indexChars: 1,
      },
      explain: { stages: [{ stage: "scope", executed: true }] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects recallId を欠く RecallResult", () => {
    const result = RecallResultSchema.safeParse({
      memories: [],
      omitted: [],
      index: { groups: [], totalInScope: 0, countKind: "exact" },
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
      },
      explain: { stages: [] },
    });
    expect(result.success).toBe(false);
  });
});

describe("RecallUsageSchema — share は非負の値だけを受け付ける（ADR 0097）", () => {
  const base = {
    chars: 100,
    estimatedTokens: 25,
    counter: "heuristic" as const,
    byTier: { full: 0, digest: 60, index: 40 },
    indexChars: 40,
  };

  it("share が 1 以下なら受け付ける", () => {
    expect(RecallUsageSchema.safeParse({ ...base, share: 0.6 }).success).toBe(true);
    expect(RecallUsageSchema.safeParse({ ...base, share: 1 }).success).toBe(true);
  });

  /**
   * **⚠ 以前はここで `.max(1)` により弾いていたが、ADR 0097 で外した。**
   * 「割合として成立しない値」を型で弾く、という以前の意図は誠実だったが、
   * 前提（段4の切り詰めが `share` の分子の予算内を保証する）が現物では成り立っていなかった
   * ——強制側（段4の `unitTokens`。digest ごとに ceil）と `share` の分子
   * （連結して ceil 1回）は数え方が違うため、`share` は実際に 1 を超える
   * （`recall-pipeline.test.ts` の `usage.budgetExceeded` 節で実測。非CJK20字の digest2件・
   * `maxMemoryTokens: 10` で `share = 1.1`）。
   * ⟹ **1 を超える値を弾くのは、実在する正しい値を「不正」と誤診断することになる。**
   * 弾くのをやめ、`share > 1` のときは `budgetExceeded: true` が伴うことを別の歯
   * （`recall-pipeline.test.ts`）で保証する形に変えた。
   */
  it("share が 1 を超える形も、いまは受け付ける（超過は budgetExceeded が示す）", () => {
    expect(RecallUsageSchema.safeParse({ ...base, share: 2.483 }).success).toBe(true);
  });

  it("share が負の値は弾く（nonnegative は残している）", () => {
    expect(RecallUsageSchema.safeParse({ ...base, share: -0.1 }).success).toBe(false);
  });
});

describe("RecallUsageSchema — budgetExceeded は additive（Issue #108「案3」）", () => {
  const base = {
    chars: 100,
    estimatedTokens: 25,
    counter: "heuristic" as const,
    byTier: { full: 0, digest: 60, index: 40 },
    indexChars: 40,
  };

  it("budgetExceeded を省略しても受け付ける（既存の呼び出しを壊さない）", () => {
    expect(RecallUsageSchema.safeParse(base).success).toBe(true);
  });

  it("budgetExceeded: true / false のどちらも受け付ける", () => {
    expect(RecallUsageSchema.safeParse({ ...base, budgetExceeded: true }).success).toBe(true);
    expect(RecallUsageSchema.safeParse({ ...base, budgetExceeded: false }).success).toBe(true);
  });

  it("真偽値以外は弾く", () => {
    expect(RecallUsageSchema.safeParse({ ...base, budgetExceeded: "true" }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { RecalledMemory, ScoreBreakdown } from "@mnemora/core";
import type { ArmReport, ProbeOutcome } from "../retrieval-quality.js";
import {
  SCORE_TERMS,
  formatArmDetail,
  collectScoreDetails,
  computeTermSpreads,
  formatScoreDetail,
  formatScoreValue,
  formatTermSpreads,
} from "../retrieval-quality.js";

/**
 * `recall()` が返す `RecalledMemory` の最小の作り。`score` 以外はこの検査の対象ではない。
 */
function memory(
  digest: string,
  score: Partial<ScoreBreakdown> & { total: number },
): RecalledMemory {
  return {
    memoryId: `memory-${digest}`,
    digest,
    retrievedVia: "ann",
    provenanceKind: "stated",
    score: {
      decay: 1,
      tagMatch: 1,
      freshness: 1,
      strength: 1,
      ...score,
    },
  };
}

describe("computeTermSpreads", () => {
  it("項ごとに max - min を出す（total は対象にしない）", () => {
    // 2 の冪だけを使う——浮動小数の誤差を検査の主題にしないため。
    const spreads = computeTermSpreads([
      memory("a", {
        similarity: 0.5,
        decay: 0.75,
        tagMatch: 1,
        freshness: 0.25,
        strength: 1,
        total: 1,
      }),
      memory("b", {
        similarity: 0.25,
        decay: 0.5,
        tagMatch: 1.5,
        freshness: 0.25,
        strength: 0.25,
        total: 2,
      }),
    ]);
    expect(spreads.map((s) => s.term)).toEqual([...SCORE_TERMS]);
    expect(spreads).toEqual([
      { term: "similarity", presentCount: 2, min: 0.25, max: 0.5, spread: 0.25 },
      { term: "decay", presentCount: 2, min: 0.5, max: 0.75, spread: 0.25 },
      { term: "tagMatch", presentCount: 2, min: 1, max: 1.5, spread: 0.5 },
      { term: "freshness", presentCount: 2, min: 0.25, max: 0.25, spread: 0 },
      { term: "strength", presentCount: 2, min: 0.25, max: 1, spread: 0.75 },
    ]);
  });

  it("similarity を持たない候補が混ざると、similarity だけ presentCount が小さくなる", () => {
    const spreads = computeTermSpreads([
      memory("ann", { similarity: 0.6, total: 0.6 }),
      memory("tag-match-経由", { total: 0.5 }),
    ]);
    const similarity = spreads.find((s) => s.term === "similarity");
    expect(similarity).toEqual({
      term: "similarity",
      presentCount: 1,
      min: 0.6,
      max: 0.6,
      spread: 0,
    });
    expect(spreads.find((s) => s.term === "decay")?.presentCount).toBe(2);
  });

  it("候補が0件なら spread は 0 ではなく null（差が無かった、と、測る対象が無かった、を分ける）", () => {
    const spreads = computeTermSpreads([]);
    expect(spreads).toHaveLength(SCORE_TERMS.length);
    for (const spread of spreads) {
      expect(spread).toEqual({
        term: spread.term,
        presentCount: 0,
        min: null,
        max: null,
        spread: null,
      });
    }
  });

  it("どの候補も similarity を持たなければ similarity だけ null になり、他の項は数値のまま", () => {
    const spreads = computeTermSpreads([
      memory("x", { total: 1 }),
      memory("y", { decay: 0.5, total: 0.5 }),
    ]);
    expect(spreads.find((s) => s.term === "similarity")?.spread).toBeNull();
    expect(spreads.find((s) => s.term === "decay")?.spread).toBe(0.5);
  });
});

describe("collectScoreDetails", () => {
  const memories = [
    memory("1位=distractor", { similarity: 0.47, total: 0.47 }),
    memory("2位=gold", { similarity: 0.45, total: 0.45 }),
    memory("3位=無関係", { similarity: 0.27, total: 0.27 }),
  ];

  it("distractor が gold より上なら、順位の昇順で2件返る", () => {
    const details = collectScoreDetails(memories, { goldRank: 2, distractorRank: 1 });
    expect(details.map((d) => [d.rank, d.roles, d.digest])).toEqual([
      [1, ["distractor", "top1"], "1位=distractor"],
      [2, ["gold"], "2位=gold"],
    ]);
    expect(details[1]?.score.total).toBe(0.45);
  });

  it("gold が1位なら1件にまとまり、roles が両方付く", () => {
    const details = collectScoreDetails(memories, { goldRank: 1, distractorRank: 2 });
    expect(details).toHaveLength(2);
    expect(details[0]?.roles).toEqual(["gold", "top1"]);
    expect(details[1]?.roles).toEqual(["distractor"]);
  });

  it("gold が返っていなければ gold のエントリを作らない（0 や「不明」を捏造しない）", () => {
    const details = collectScoreDetails(memories, { goldRank: null, distractorRank: 1 });
    expect(details).toHaveLength(1);
    expect(details[0]?.roles).toEqual(["distractor", "top1"]);
  });

  it("候補が0件なら top1 も作らず空配列を返す", () => {
    expect(collectScoreDetails([], { goldRank: null, distractorRank: null })).toEqual([]);
  });
});

describe("formatScoreValue", () => {
  it("1e-4 未満の値を 0.000000 に潰さず指数表記にする", () => {
    expect(formatScoreValue(1.6e-5)).toBe("1.600e-5");
  });

  it("0 はそのまま 0.000000 と出す（指数表記にしない）", () => {
    expect(formatScoreValue(0)).toBe("0.000000");
  });

  it("通常の値は小数6桁で出す", () => {
    expect(formatScoreValue(0.471843)).toBe("0.471843");
  });

  it("負の小さい値も指数表記にする（符号は残す）", () => {
    expect(formatScoreValue(-1.6e-5)).toBe("-1.600e-5");
  });

  it("負の大きい値は指数表記にしない（判定は絶対値で行う）", () => {
    // `similarity = 1 - distance` であり、コサイン距離は最大 2 まで出る。
    // ⟹ 向きが逆のベクトルでは similarity が負になりうる。符号だけを見て
    // 「小さい」と判定すると、-0.5 のような大きな負の値まで指数表記に倒れる。
    expect(formatScoreValue(-0.5)).toBe("-0.500000");
  });

  it("1e-4 ちょうどは指数表記にしない（境界は「未満」）", () => {
    expect(formatScoreValue(1e-4)).toBe("0.000100");
  });
});

describe("formatTermSpreads / formatScoreDetail", () => {
  it("spread が null の項は「この項を持つ候補が無い」と出す", () => {
    const line = formatTermSpreads(computeTermSpreads([memory("x", { total: 1 })]));
    expect(line).toContain("similarity=(この項を持つ候補が無い)");
    expect(line).toContain("decay=0.000000");
  });

  it("similarity を持たない候補は「(ANN 経由でない)」と出す", () => {
    const [detail] = collectScoreDetails([memory("tag 経由", { total: 0.5 })], {
      goldRank: 1,
      distractorRank: null,
    });
    expect(formatScoreDetail(detail!)).toBe(
      "#1 [gold,top1] total=0.500000 = similarity (ANN 経由でない) × decay 1.000000 × " +
        "tagMatch 1.000000 × freshness 1.000000 × strength 1.000000  tag 経由",
    );
  });

  it("掛け算の形をそのまま出す（順位・役・内訳・digest が1行に揃う）", () => {
    // **5項すべてに違う値を入れる。**同じ値を並べると、項を取り違える実装
    // （例: decay の位置に freshness を出す）をこの検査が通してしまう。
    const [detail] = collectScoreDetails(
      [
        memory("父は毎晩ウォーキングをしています。", {
          similarity: 0.471843,
          decay: 0.999979,
          tagMatch: 1.1,
          freshness: 0.987654,
          strength: 0.9,
          total: 0.471823,
        }),
      ],
      { goldRank: null, distractorRank: 1 },
    );
    expect(formatScoreDetail(detail!)).toBe(
      "#1 [distractor,top1] total=0.471823 = similarity 0.471843 × decay 0.999979 × " +
        "tagMatch 1.100000 × freshness 0.987654 × strength 0.900000  父は毎晩ウォーキングをしています。",
    );
  });
});

// ---------------------------------------------------------------------------
// formatArmDetail — 上で作った内訳が、実際に arm の出力へ載っているか
//
// **なぜここまで見るか**: 純関数が正しくても、それを印字に配線し忘れれば
// 出力からは何も分からない。この PR が直しているのは「ベンチが説明を捨てていた」
// ことなので、**捨てていないことを出力の側で押さえる。**
// ---------------------------------------------------------------------------

function probe(overrides: Partial<ProbeOutcome> = {}): ProbeOutcome {
  const memories = [
    memory("父は毎晩ウォーキングをしている。", {
      similarity: 0.468831,
      decay: 0.999979,
      freshness: 0.999979,
      total: 0.468811,
    }),
    memory("毎朝5時に起きてジョギングをしている。", {
      similarity: 0.449758,
      decay: 0.999978,
      freshness: 0.999978,
      total: 0.449738,
    }),
  ];
  return {
    probeId: "exercise",
    lexicalControl: false,
    goldRank: 2,
    distractorRank: 1,
    hit1: false,
    hit10: true,
    distractorBeatsGold: true,
    reciprocalRank: 0.5,
    omittedKinds: ["ann_truncated", "over_limit"],
    totalInScope: 75,
    scoreDetails: collectScoreDetails(memories, { goldRank: 2, distractorRank: 1 }),
    termSpreads: computeTermSpreads(memories),
    ...overrides,
  };
}

function armReport(): ArmReport {
  return {
    armLabel: "C: 本物LLM+本物の埋め込み",
    tenantId: "retrieval-quality-arm-c",
    llmMode: "openai",
    embeddingMode: "openai",
    ingest: {
      observationCount: 74,
      drain: { ticks: 3, totalProcessed: 75, totalFailed: 0, firstTickProcessed: 50 },
      extractionCounts: { ok: 74, skipped: 0, llmFailedWholeObservation: 0 },
      measurement: "measured",
      singleTickWouldHaveStalled: true,
    },
    probes: [probe()],
    mrrOverall: 0.5,
    mrrLexicalControl: 0,
    mrrNonLexical: 0.5,
    usageReport: "(usage)",
  };
}

describe("formatArmDetail", () => {
  it("probe ごとに、項ごとの値の幅を出す", () => {
    expect(formatArmDetail(armReport())).toContain(
      "項ごとの値の幅(返った候補全体): similarity=0.019073 decay=1.000e-6 " +
        "tagMatch=0.000000 freshness=1.000e-6 strength=0.000000",
    );
  });

  it("gold と distractor のスコア内訳を、掛け算の形のまま出す", () => {
    const out = formatArmDetail(armReport());
    expect(out).toContain(
      "#1 [distractor,top1] total=0.468811 = similarity 0.468831 × decay 0.999979 × " +
        "tagMatch 1.000000 × freshness 0.999979 × strength 1.000000  父は毎晩ウォーキングをしている。",
    );
    expect(out).toContain(
      "#2 [gold] total=0.449738 = similarity 0.449758 × decay 0.999978 × " +
        "tagMatch 1.000000 × freshness 0.999978 × strength 1.000000  毎朝5時に起きてジョギングをしている。",
    );
  });

  it("gold が返っていない probe では、gold の行を出さない（内訳を捏造しない）", () => {
    const out = formatArmDetail({
      ...armReport(),
      probes: [probe({ goldRank: null, hit10: false, reciprocalRank: 0, scoreDetails: [] })],
    });
    expect(out).toContain("goldRank=(無し)");
    expect(out).not.toContain("[gold]");
  });
});

import { describe, expect, it } from "vitest";
import { decideAnnTruncation } from "../ann-truncation.js";
import type { ScoringStrategy } from "../strategies/scoring.js";
import { defaultScoringStrategy } from "../strategies/scoring.js";

/**
 * `decideAnnTruncation` の歯（[ADR 0069](../../../../docs/decisions/0069-ann-truncated-says-nothing-about-loss.md) 案A）。
 *
 * **DB もカセットも要らない。**判定は純関数であり、`recall()` を通さずに測れる——
 * だからこそ「上界を宣言しない戦略」のような、通常の配線からは作れない状況も測れる。
 */

/** 上界の宣言を持たない戦略。**素の関数がそのまま `ScoringStrategy` として通る**ことを使う。 */
const undeclaredStrategy: ScoringStrategy = (input) => ({
  decay: 1,
  tagMatch: 1,
  freshness: 1,
  strength: input.strength,
  total: (input.similarity ?? 1) * input.strength,
});

/**
 * 上界を「宣言できない」と*申告する*戦略。`undeclaredStrategy`（機構ごと持たない）とは別。
 *
 * **⚠ `Object.assign(undeclaredStrategy, ...)` と書かないこと**——`Object.assign` は
 * 第1引数を**書き換える**ので、`undeclaredStrategy` の側に宣言が生えてしまい、
 * 「機構ごと持たない」ほうの歯が別のものを測ることになる（実際に一度そうなり、
 * 上の歯が赤くなって気づいた）。**新しい関数を作ってから生やす。**
 */
const refusingStrategy: ScoringStrategy = Object.assign(
  ((input) => undeclaredStrategy(input)) as ScoringStrategy,
  {
    nonSimilarityUpperBound: () => ({
      kind: "undeclared" as const,
      reason: "この戦略は上界を持たない",
    }),
  },
);

const base = {
  strategy: defaultScoringStrategy,
  queryTags: [] as readonly string[],
  scoreThreshold: 0.1,
};

describe("decideAnnTruncation — 3つの状態が別の顔で返る（ADR 0069 の芯）", () => {
  // 🔑 **これがこの決定の芯である。**「安全だと証明できた」と「判定できなかった」が
  // 同じ形で返ったら、(c)「沈黙と判定不能を分ける」を採った意味が消える。
  it("沈黙・判定不能・発火は、それぞれ別の kind を返す（同じ値・同じ形にならない）", () => {
    const safe = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: 0.2,
      lastReturnedTotal: 0.5,
    });
    const fires = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: 0.5,
      lastReturnedTotal: 0.2,
    });
    const undecidable = decideAnnTruncation({
      ...base,
      strategy: undeclaredStrategy,
      lastAnnSimilarity: 0.2,
      lastReturnedTotal: 0.5,
    });

    expect(safe.kind).toBe("provably_safe");
    expect(fires.kind).toBe("loss_possible");
    expect(undecidable.kind).toBe("undecidable");

    // 3つが互いに区別できること（値としても形としても）。
    const kinds = new Set([safe.kind, fires.kind, undecidable.kind]);
    expect(kinds.size).toBe(3);

    // **判定不能は safetyRatio を持たない。**持たせると「余裕が 0 だった」と読める。
    expect("safetyRatio" in undecidable).toBe(false);
    // **判定不能は reason を持つ。**なぜ判定できなかったかを捨てない。
    if (undecidable.kind !== "undecidable") throw new Error("unreachable");
    expect(undecidable.reason.length).toBeGreaterThan(0);
  });

  it("上界を宣言しない戦略は undecidable に落ちる（既定の上界を黙って当てはめない）", () => {
    const v = decideAnnTruncation({
      ...base,
      strategy: undeclaredStrategy,
      lastAnnSimilarity: 0.2,
      lastReturnedTotal: 0.5,
    });
    expect(v.kind).toBe("undecidable");
    if (v.kind !== "undecidable") throw new Error("unreachable");
    expect(v.reason).toContain("nonSimilarityUpperBound");
  });

  it("上界を「宣言できない」と申告した戦略も undecidable に落ちる（申告の理由を運ぶ）", () => {
    const v = decideAnnTruncation({
      ...base,
      strategy: refusingStrategy,
      lastAnnSimilarity: 0.2,
      lastReturnedTotal: 0.5,
    });
    expect(v.kind).toBe("undecidable");
    if (v.kind !== "undecidable") throw new Error("unreachable");
    expect(v.reason).toContain("この戦略は上界を持たない");
  });
});

describe("decideAnnTruncation — R = 1 の境界", () => {
  // R = bar / (sim_k' × M_max)。queryTags が空なら M_max = 1 なので R = bar / sim_k'。
  it("R がちょうど 1 なら provably_safe（等号は安全側）", () => {
    const v = decideAnnTruncation({ ...base, lastAnnSimilarity: 0.4, lastReturnedTotal: 0.4 });
    expect(v.kind).toBe("provably_safe");
    if (v.kind === "undecidable") throw new Error("unreachable");
    expect(v.safetyRatio).toBeCloseTo(1, 12);
  });

  it("R が 1 をわずかに下回れば loss_possible", () => {
    const v = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: 0.4 * (1 - 1e-9),
    });
    expect(v.kind).toBe("loss_possible");
  });

  it("R が 1 をわずかに上回れば provably_safe", () => {
    const v = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: 0.4 * (1 + 1e-9),
    });
    expect(v.kind).toBe("provably_safe");
  });
});

describe("decideAnnTruncation — M_max はクエリタグ数で動く", () => {
  it("クエリにタグが1つ在ると上界が 1.1 倍になり、同じ入力でも判定が変わる", () => {
    const withoutTags = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: 0.4,
    });
    const withTag = decideAnnTruncation({
      ...base,
      queryTags: ["x"],
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: 0.4,
    });
    expect(withoutTags.kind).toBe("provably_safe");
    expect(withTag.kind).toBe("loss_possible");
    if (withTag.kind !== "loss_possible") throw new Error("unreachable");
    expect(withTag.safetyRatio).toBeCloseTo(1 / 1.1, 9);
  });
});

describe("decideAnnTruncation — bar の決め方（limit に満たなかったとき）", () => {
  it("lastReturnedTotal が null なら scoreThreshold を基準にする", () => {
    // 閾値を超える候補なら必ず返っていたはずなので、窓の外が「入れたはず」と言えるのは
    // 閾値を超えられた場合だけ。sim_k'=0.4, M_max=1, threshold=0.5 ⟹ R = 1.25 ⟹ 安全。
    const v = decideAnnTruncation({
      ...base,
      scoreThreshold: 0.5,
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: null,
    });
    expect(v.kind).toBe("provably_safe");
    if (v.kind === "undecidable") throw new Error("unreachable");
    expect(v.safetyRatio).toBeCloseTo(1.25, 9);
  });

  it("閾値が低ければ、limit 未満でも loss_possible になりうる", () => {
    const v = decideAnnTruncation({
      ...base,
      scoreThreshold: 0.1,
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: null,
    });
    expect(v.kind).toBe("loss_possible");
  });
});

describe("decideAnnTruncation — 端の入力は黙って握り潰さず undecidable にする", () => {
  it.each([
    ["sim_k' が 0", 0],
    ["sim_k' が負（コサインは負になりうる）", -0.3],
    ["sim_k' が NaN", Number.NaN],
  ])("%s なら undecidable", (_label, sim) => {
    const v = decideAnnTruncation({ ...base, lastAnnSimilarity: sim, lastReturnedTotal: 0.5 });
    expect(v.kind).toBe("undecidable");
  });

  it("bar が NaN（score_not_comparable の領域）なら undecidable", () => {
    const v = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: Number.NaN,
    });
    expect(v.kind).toBe("undecidable");
  });
});

describe("decideAnnTruncation — 前提を戻り値で名乗る（ADR 0069 §6）", () => {
  // 🔴 **コメントは検査されない。**だから前提は戻り値に載せ、その中身をここで測る。
  it.each([
    ["provably_safe", 0.2, 0.5],
    ["loss_possible", 0.5, 0.2],
  ])("%s のとき assumptions が decay と strength の前提を名乗る", (kind, sim, total) => {
    const v = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: sim,
      lastReturnedTotal: total,
    });
    expect(v.kind).toBe(kind);
    if (v.kind === "undecidable") throw new Error("unreachable");
    expect(v.assumptions.length).toBeGreaterThan(0);
    const joined = v.assumptions.join(" ");
    expect(joined).toContain("decay");
    expect(joined).toContain("strength");
    // **「clamp が無い」ことまで言っている**——「decay は 1 以下」とだけ書くと、
    // それが保証なのか前提なのかが読み手に伝わらない。
    expect(joined).toContain("clamp");
  });
});

/**
 * ⭐ ADR 0069 §5 の実測値を、そのまま歯に固定する。
 *
 * 出所: `examples/chat/cassettes/retrieval.json`（実 `text-embedding-3-small`/256次元）から
 * 担当者が計算した、スコープ 75件・k'=40 のときの `sim@10` と `sim@40`。
 *
 * **この歯が測っているのは判定式の振る舞いであって、埋め込みの質ではない。**
 * 数字が古びたら（モデルを替えた等）この歯は赤くなる——そのときは ADR 0069 §5 の表ごと
 * 測り直すこと。**数字だけ書き換えて通さないこと。**
 */
const PROBE_SIMILARITIES: readonly { id: string; sim10: number; sim40: number }[] = [
  { id: "color", sim10: 0.244646, sim40: 0.168179 },
  { id: "pet", sim10: 0.278239, sim40: 0.192306 },
  { id: "exercise", sim10: 0.222407, sim40: 0.172327 },
  { id: "diet", sim10: 0.182948, sim40: 0.097257 },
  { id: "family", sim10: 0.184681, sim40: 0.101286 },
  { id: "language", sim10: 0.146188, sim40: 0.076399 },
  { id: "travel", sim10: 0.230617, sim40: 0.148676 },
];

describe("decideAnnTruncation — ADR 0069 §5 の実測値（retrieval ベンチの 7 probe）", () => {
  it.each(PROBE_SIMILARITIES)("$id: いまの世界（4項が定数）では沈黙する", ({ sim10, sim40 }) => {
    // いまの世界: occurredAt は全件 null、strength は全件 1、クエリタグ無し
    // ⟹ 返った10位の total は similarity そのもの。
    const v = decideAnnTruncation({ ...base, lastAnnSimilarity: sim40, lastReturnedTotal: sim10 });
    expect(v.kind).toBe("provably_safe");
    if (v.kind === "undecidable") throw new Error("unreachable");
    expect(v.safetyRatio).toBeGreaterThanOrEqual(1);
  });

  it.each(PROBE_SIMILARITIES)(
    "$id: occurredAt が入って freshness が 0.5 まで落ちうる世界では鳴る",
    ({ sim10, sim40 }) => {
      // 10位の記憶の occurredAt が半減期（720h = 30日）前だと freshness = 0.5。
      // 窓の外の候補は未来の occurredAt を持ちうるので上界は 1.0 のまま
      // （ADR 0036 の clamp）。⟹ R = (sim10 × 0.5) / (sim40 × 1.0)。
      const v = decideAnnTruncation({
        ...base,
        lastAnnSimilarity: sim40,
        lastReturnedTotal: sim10 * 0.5,
      });
      expect(v.kind).toBe("loss_possible");
      if (v.kind !== "loss_possible") throw new Error("unreachable");
      expect(v.safetyRatio).toBeLessThan(1);
    },
  );

  it("7 probe すべてが同じ向きに動く（沈黙 7/7 → 発火 7/7）", () => {
    const silent = PROBE_SIMILARITIES.filter(
      ({ sim10, sim40 }) =>
        decideAnnTruncation({ ...base, lastAnnSimilarity: sim40, lastReturnedTotal: sim10 })
          .kind === "provably_safe",
    );
    const firing = PROBE_SIMILARITIES.filter(
      ({ sim10, sim40 }) =>
        decideAnnTruncation({
          ...base,
          lastAnnSimilarity: sim40,
          lastReturnedTotal: sim10 * 0.5,
        }).kind === "loss_possible",
    );
    expect(silent).toHaveLength(7);
    expect(firing).toHaveLength(7);
  });
});

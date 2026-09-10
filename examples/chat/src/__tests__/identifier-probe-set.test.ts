import { describe, expect, it } from "vitest";
import { DEFAULT_HAYSTACK_SIZE, buildHaystackUtterance } from "../probe-set.js";
import {
  DEFAULT_DENSE_HAYSTACK_SIZE,
  IDENTIFIER_PROBES,
  IDENTIFIER_TOPIC_KEYWORDS,
  buildDenseIdentifierHaystackUtterance,
  buildIdentifierProbeSetConversation,
  findIdentifierTopicKeywordViolations,
  identifierDistractorExternalId,
  identifierGoldExternalId,
  identifierHaystackExternalId,
} from "../identifier-probe-set.js";

/**
 * Issue #109: 識別子 probe set 自体の整合性(DB もネットワークも要らない)。
 *
 * ⚠ `probe-set.ts` は1文字も変更していない——`buildHaystackUtterance`/
 * `DEFAULT_HAYSTACK_SIZE` を import して確認するだけである。
 */
describe("identifier-probe-set", () => {
  it("Issue #106 が名指しした5領域を、まず12件で覆っている", () => {
    expect(IDENTIFIER_PROBES).toHaveLength(12);
    const categories = new Set(IDENTIFIER_PROBES.map((p) => p.category));
    expect(categories).toEqual(new Set(["person", "channel", "system", "project-code", "ticket"]));
  });

  it("probe id は重複しない", () => {
    const ids = IDENTIFIER_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("query は識別子そのものを含む(既存 probe-set.ts とは逆の狙い)", () => {
    for (const probe of IDENTIFIER_PROBES) {
      const keywords = IDENTIFIER_TOPIC_KEYWORDS[probe.id] ?? [];
      const [goldIdentifier] = keywords;
      expect(goldIdentifier).toBeDefined();
      expect(probe.query.includes(goldIdentifier!)).toBe(true);
      expect(probe.fact.includes(goldIdentifier!)).toBe(true);
    }
  });

  it("distractor は同じ書式・違う識別子である(gold の識別子を含まない)", () => {
    for (const probe of IDENTIFIER_PROBES) {
      const [goldIdentifier, distractorIdentifier] = IDENTIFIER_TOPIC_KEYWORDS[probe.id] ?? [];
      expect(distractorIdentifier).toBeDefined();
      expect(probe.distractor.includes(distractorIdentifier!)).toBe(true);
      expect(probe.distractor.includes(goldIdentifier!)).toBe(false);
    }
  });

  it("すべての識別子がユニークである(probe 間で使い回していない)", () => {
    const all = Object.values(IDENTIFIER_TOPIC_KEYWORDS).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("既定の haystack(probe-set.ts の生成器)は識別子と重ならない(機械的検査)", () => {
    const haystackTexts = Array.from({ length: DEFAULT_HAYSTACK_SIZE }, (_, i) =>
      buildHaystackUtterance(i),
    );
    expect(findIdentifierTopicKeywordViolations(haystackTexts)).toEqual([]);
  });

  it("haystack が識別子と重なっていれば違反を報告する(検査自体が機能することの確認)", () => {
    const violations = findIdentifierTopicKeywordViolations(["PROJ-1234 の件です。"]);
    expect(violations).toEqual([{ index: 0, text: "PROJ-1234 の件です。", keyword: "PROJ-1234" }]);
  });

  it("buildIdentifierProbeSetConversation: gold/distractor/haystack の externalId が既定の規約に従う", () => {
    const utterances = buildIdentifierProbeSetConversation(4);
    expect(utterances).toHaveLength(IDENTIFIER_PROBES.length * 2 + 4);
    for (const probe of IDENTIFIER_PROBES) {
      const gold = utterances.find((u) => u.externalId === identifierGoldExternalId(probe.id));
      const distractor = utterances.find(
        (u) => u.externalId === identifierDistractorExternalId(probe.id),
      );
      expect(gold?.text).toBe(probe.fact);
      expect(gold?.kind).toBe("gold");
      expect(distractor?.text).toBe(probe.distractor);
      expect(distractor?.kind).toBe("distractor");
    }
    expect(utterances.some((u) => u.externalId === identifierHaystackExternalId(0))).toBe(true);
  });

  it("haystackSize=0 でも例外にならない(境界値)", () => {
    const utterances = buildIdentifierProbeSetConversation(0);
    expect(utterances).toHaveLength(IDENTIFIER_PROBES.length * 2);
  });

  // ---------------------------------------------------------------------------
  // dense haystack(マネージャー指示: #106「同じ形式の別の識別子が近傍に来て埋もれる」
  // の再点検)。
  // ---------------------------------------------------------------------------

  describe("dense haystack", () => {
    it("既定件数(DEFAULT_DENSE_HAYSTACK_SIZE)は sparse の既定と同程度である", () => {
      expect(DEFAULT_DENSE_HAYSTACK_SIZE).toBe(60);
    });

    it("dense haystack は12 probe の識別子と1件も衝突しない(機械的検査)", () => {
      const denseTexts = Array.from({ length: DEFAULT_DENSE_HAYSTACK_SIZE }, (_, i) =>
        buildDenseIdentifierHaystackUtterance(i),
      );
      expect(findIdentifierTopicKeywordViolations(denseTexts)).toEqual([]);
    });

    it("dense haystack の各文はユニークである(同じ文を繰り返さない)", () => {
      const denseTexts = Array.from({ length: DEFAULT_DENSE_HAYSTACK_SIZE }, (_, i) =>
        buildDenseIdentifierHaystackUtterance(i),
      );
      expect(new Set(denseTexts).size).toBe(denseTexts.length);
    });

    it("範囲外の index は例外になる(総件数を超えたら黙って何かを返さない)", () => {
      expect(() => buildDenseIdentifierHaystackUtterance(DEFAULT_DENSE_HAYSTACK_SIZE)).toThrow(
        /総件数/,
      );
    });

    it('buildIdentifierProbeSetConversation(undefined, "dense") は既定で60件のdense haystackを使う', () => {
      const utterances = buildIdentifierProbeSetConversation(undefined, "dense");
      expect(utterances).toHaveLength(IDENTIFIER_PROBES.length * 2 + DEFAULT_DENSE_HAYSTACK_SIZE);
      const haystackOnly = utterances.filter((u) => u.kind === "haystack");
      expect(haystackOnly).toHaveLength(DEFAULT_DENSE_HAYSTACK_SIZE);
      // dense haystack は書式ファミリーの識別子を含む(sparse には無い性質)。
      expect(haystackOnly.some((u) => u.text.includes("PROJ-2001"))).toBe(true);
    });

    it("haystackKind を渡さなければ sparse のまま(既存呼び出しは1ミリも変わらない)", () => {
      const utterances = buildIdentifierProbeSetConversation(4);
      const haystackOnly = utterances.filter((u) => u.kind === "haystack");
      expect(haystackOnly.map((u) => u.text)).toEqual([
        buildHaystackUtterance(0),
        buildHaystackUtterance(1),
        buildHaystackUtterance(2),
        buildHaystackUtterance(3),
      ]);
    });
  });
});

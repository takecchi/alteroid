import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_LADDER,
  DEFAULT_GROUP_SIZE,
  DEFAULT_RECALL_LIMIT,
  parseConsolidationCostOptions,
} from "../consolidation-cost-options.js";

describe("parseConsolidationCostOptions", () => {
  it("環境変数が無ければ既定値", () => {
    const options = parseConsolidationCostOptions({});
    expect(options.groupSize).toBe(DEFAULT_GROUP_SIZE);
    expect(options.budgetLadder).toEqual([...DEFAULT_BUDGET_LADDER]);
    expect(options.recallLimit).toBe(DEFAULT_RECALL_LIMIT);
  });

  it("MNEMORA_CONSOLIDATION_GROUP_SIZE を数値として読む", () => {
    const options = parseConsolidationCostOptions({ MNEMORA_CONSOLIDATION_GROUP_SIZE: "7" });
    expect(options.groupSize).toBe(7);
  });

  it("MNEMORA_CONSOLIDATION_GROUP_SIZE が1なら例外(1件を1件に統合しない、と同じ理由)", () => {
    expect(() => parseConsolidationCostOptions({ MNEMORA_CONSOLIDATION_GROUP_SIZE: "1" })).toThrow(
      /2以上/,
    );
  });

  it("MNEMORA_CONSOLIDATION_GROUP_SIZE が0以下なら(正の整数でないため)例外", () => {
    expect(() =>
      parseConsolidationCostOptions({ MNEMORA_CONSOLIDATION_GROUP_SIZE: "0" }),
    ).toThrow();
  });

  it("MNEMORA_CONSOLIDATION_GROUP_SIZE が整数でなければ例外", () => {
    expect(() =>
      parseConsolidationCostOptions({ MNEMORA_CONSOLIDATION_GROUP_SIZE: "abc" }),
    ).toThrow();
    expect(() =>
      parseConsolidationCostOptions({ MNEMORA_CONSOLIDATION_GROUP_SIZE: "2.5" }),
    ).toThrow();
  });

  it("MNEMORA_CONSOLIDATION_BUDGET_LADDER をカンマ区切りの数値配列として読む", () => {
    const options = parseConsolidationCostOptions({
      MNEMORA_CONSOLIDATION_BUDGET_LADDER: "16, 48,96",
    });
    expect(options.budgetLadder).toEqual([16, 48, 96]);
  });

  it("MNEMORA_CONSOLIDATION_BUDGET_LADDER の値が不正なら例外", () => {
    expect(() =>
      parseConsolidationCostOptions({ MNEMORA_CONSOLIDATION_BUDGET_LADDER: "16,-1" }),
    ).toThrow();
    expect(() =>
      parseConsolidationCostOptions({ MNEMORA_CONSOLIDATION_BUDGET_LADDER: "16,abc" }),
    ).toThrow();
  });

  it("MNEMORA_CONSOLIDATION_RECALL_LIMIT を数値として読む", () => {
    const options = parseConsolidationCostOptions({ MNEMORA_CONSOLIDATION_RECALL_LIMIT: "20" });
    expect(options.recallLimit).toBe(20);
  });

  it("MNEMORA_CONSOLIDATION_RECALL_LIMIT が正の整数でなければ例外", () => {
    expect(() =>
      parseConsolidationCostOptions({ MNEMORA_CONSOLIDATION_RECALL_LIMIT: "-5" }),
    ).toThrow();
  });
});

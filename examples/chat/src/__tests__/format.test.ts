import { describe, expect, it } from "vitest";
import type { RecallResult } from "@mnemora/core";
import { formatRecall } from "../format.js";
import type { ComparisonRow } from "../compare.js";
import { formatRecallQualityTable } from "../compare.js";

function baseResult(overrides: Partial<RecallResult> = {}): RecallResult {
  return {
    recallId: "recall-1",
    memories: [],
    omitted: [],
    index: { groups: [], totalInScope: 0, countKind: "exact" },
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    explain: { stages: [] },
    ...overrides,
  };
}

describe("formatRecall", () => {
  it("omitted が空、share 無しの場合は「(無し)」と share 抜きの usage 行を出す", () => {
    const output = formatRecall(baseResult(), "test");
    expect(output).toContain("(無し)");
    expect(output).not.toContain("share=");
  });

  it("omitted が非空、share ありの場合はその内容と share を出す", () => {
    const result = baseResult({
      omitted: [{ kind: "budget_dropped", count: 3, countKind: "exact" }],
      usage: {
        chars: 50,
        estimatedTokens: 13,
        counter: "heuristic",
        byTier: { full: 0, digest: 50, index: 0 },
        indexChars: 0,
        share: 0.5,
      },
    });
    const output = formatRecall(result, "test");
    expect(output).not.toContain("(無し)");
    expect(output).toContain("budget_dropped");
    expect(output).toContain("share=50.0%");
  });
});

// ---------------------------------------------------------------------------
// formatRecallQualityTable
//
// これは DB を要さない、純粋な整形の検査である——`ComparisonRow` を手で組み立てて
// 渡すだけで、`recall()` や Postgres を一切呼ばない。北極星の物差し
// （「削っても目的の記憶が落ちないと言えるか」）に答える表そのものが、
// `omitted` の件数と「ANN の候補になれた件数」を落とさずに出すことを押さえる。
// ---------------------------------------------------------------------------

function baseRow(overrides: Partial<ComparisonRow> = {}): ComparisonRow {
  return {
    fillerPairs: 320,
    turnCount: 642,
    naiveChars: 10000,
    naiveTokens: 3000,
    mnemoraChars: 400,
    mnemoraTokens: 120,
    mnemoraShareOfNaiveChars: 0.04,
    totalInScope: 321,
    omitted: [],
    returnedCount: 10,
    annCandidateCount: 321,
    factStatementSurvived: true,
    ...overrides,
  };
}

describe("formatRecallQualityTable", () => {
  it("omitted が空なら「(無し)」を出し、ANN の候補になれた件数がスコープ内と一致する行を出す", () => {
    const output = formatRecallQualityTable([baseRow()]);
    expect(output).toContain("| 642 | 321 | 321 | 10 | ✅ | (無し) |");
  });

  it(
    "ADR 0021 前の欠陥（271件が not_indexed(pending) のまま）を件数付きで出す——" +
      "『321件と競ったのか、50件と競ったのか』が一目で分かること。" +
      "この歯は omitted の count を落として kind だけにする変異(旧 omittedKinds 相当)で赤くなる。",
    () => {
      const row = baseRow({
        totalInScope: 321,
        annCandidateCount: 50,
        omitted: [
          // ADR 0069: 札は certainty を持つようになった。**この歯の主題（件数を潰さない）は
          // 変えていない** —— 固定値を新しい形に合わせただけで、期待値は緩めていない。
          {
            kind: "ann_truncated",
            countKind: "unknown",
            certainty: "loss_possible",
            safetyRatio: 0.8,
            assumptions: ["decay <= 1: ...", "strength <= 1: ..."],
          },
          { kind: "over_limit", count: 30, countKind: "exact" },
          { kind: "not_indexed", reason: "pending", count: 271, countKind: "exact" },
        ],
      });
      const output = formatRecallQualityTable([row]);
      // スコープ内(321)とANN候補(50)が食い違うことがそのまま列に見える。
      expect(output).toContain("| 642 | 321 | 50 | 10 | ✅ | ");
      // 内訳が「件数」を保ったまま出ている(kind だけに潰されていない)。
      expect(output).toContain("not_indexed(pending):271");
      expect(output).toContain("over_limit:30");
      expect(output).toContain("ann_truncated");
    },
  );

  it("冒頭の事実が残っていない場合は ❌ を出す", () => {
    const output = formatRecallQualityTable([baseRow({ factStatementSurvived: false })]);
    expect(output).toContain("❌");
    expect(output).not.toContain("✅");
  });

  it("複数行を渡すと行数ぶん出力する", () => {
    const output = formatRecallQualityTable([
      baseRow({ turnCount: 2, totalInScope: 1, annCandidateCount: 1, returnedCount: 1 }),
      baseRow({ turnCount: 8, totalInScope: 4, annCandidateCount: 4, returnedCount: 4 }),
    ]);
    const bodyLines = output.split("\n").slice(2); // header + sep を除く
    expect(bodyLines).toHaveLength(2);
  });
});

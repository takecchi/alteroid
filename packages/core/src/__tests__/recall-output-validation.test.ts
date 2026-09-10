import { describe, expect, it } from "vitest";
import {
  RecallOutputValidationError,
  DEFAULT_RECALL_OUTPUT_VALIDATION,
  validateRecallOutput,
} from "../recall-output-validation.js";
import type { RecallResult } from "../recall.js";

/**
 * `validateRecallOutput` 単体の歯（Issue #131、ADR 0098）。
 *
 * パイプラインを通した歯は `recall-pipeline.test.ts` の
 * 「recall() — 出力検証」節に在る。ここでは**倒れ方そのもの**（3つのモードの区別と、
 * 「無い」の3種類）を、`recall()` を経由せずに直接測る。
 */

/** 検証を通るべき最小の `RecallResult`（`outputValidation` は載せる前の draft）。 */
function validDraft(overrides: Partial<RecallResult> = {}): RecallResult {
  return {
    recallId: "rcl-1",
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
    explain: { stages: [{ stage: "scope", executed: true }] },
    ...overrides,
  };
}

describe("validateRecallOutput — 既定", () => {
  it('既定のモードは "report" である（投げるほうを既定にしない。ADR 0098）', () => {
    expect(DEFAULT_RECALL_OUTPUT_VALIDATION).toBe("report");
  });
});

describe('validateRecallOutput — "off" / "report" / "throw" の3状態', () => {
  it('"off" は undefined を返す（「検証していない」——「通った」ではない）', () => {
    expect(validateRecallOutput(validDraft(), "off", "rcl-1")).toBeUndefined();
    // 壊れた draft でも同じ。"off" は判定そのものをしない。
    expect(validateRecallOutput({ ...validDraft(), recallId: "" }, "off", "rcl-1")).toBeUndefined();
  });

  it('"report" は正しい draft に対して { ok: true, issues: [] } を返す', () => {
    expect(validateRecallOutput(validDraft(), "report", "rcl-1")).toEqual({
      ok: true,
      issues: [],
    });
  });

  it('"report" は落ちても投げない——ok: false と issues を返す', () => {
    const draft = validDraft({
      usage: {
        chars: 0,
        estimatedTokens: 2.5, // int() 違反
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
    });

    const report = validateRecallOutput(draft, "report", "rcl-1");

    expect(report?.ok).toBe(false);
    expect(report?.issues.map((issue) => issue.path)).toContain("usage.estimatedTokens");
  });

  it('"throw" は落ちたときだけ投げ、issues と recallId を載せる', () => {
    const draft = validDraft({
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
        share: -0.1, // nonnegative() 違反
      },
    });

    expect(() => validateRecallOutput(draft, "throw", "rcl-7")).toThrow(
      RecallOutputValidationError,
    );

    try {
      validateRecallOutput(draft, "throw", "rcl-7");
      throw new Error("投げなかった");
    } catch (err) {
      expect(err).toBeInstanceOf(RecallOutputValidationError);
      const validationError = err as RecallOutputValidationError;
      expect(validationError.issues.map((issue) => issue.path)).toContain("usage.share");
      expect(validationError.recallId).toBe("rcl-7");
    }
  });

  it('"throw" でも、正しい draft は投げずに { ok: true, issues: [] } を返す', () => {
    expect(validateRecallOutput(validDraft(), "throw", "rcl-1")).toEqual({
      ok: true,
      issues: [],
    });
  });
});

/**
 * ⭐ ADR 0097 の欠陥を、この検証が隠さない／誤検出しないことを純関数の側でも固定する。
 * パイプライン側の同じ主張は `recall-pipeline.test.ts` の `T3`。
 */
describe("validateRecallOutput — share > 1 は契約違反ではない（ADR 0097）", () => {
  const draftWithShare = (share: number) =>
    validDraft({
      usage: {
        chars: 41,
        estimatedTokens: 11,
        counter: "heuristic",
        byTier: { full: 0, digest: 40, index: 1 },
        indexChars: 1,
        share,
        budgetExceeded: share > 1,
      },
    });

  it("share: 1.1 は ok: true として通る（.max(1) は ADR 0097 で外した）", () => {
    expect(validateRecallOutput(draftWithShare(1.1), "report", "rcl-1")).toEqual({
      ok: true,
      issues: [],
    });
  });

  it("share が負のときだけ落ちる（nonnegative は残っている）", () => {
    const report = validateRecallOutput(draftWithShare(-0.1), "report", "rcl-1");
    expect(report?.ok).toBe(false);
    expect(report?.issues.map((issue) => issue.path)).toContain("usage.share");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildSummaryMarkdown,
  diffArm,
  validateBaseline,
  validateMeasured,
} from "../retrieval-quality-summary-lib.mjs";

/**
 * `retrieval-quality-summary-lib.mjs`(純関数の側)の歯。DB を要求しない。
 *
 * `retrieval-quality-summary.test.mjs`(本物のスクリプトを子プロセスで起動する歯)とは
 * 別の観点——ここは「組み立てのロジックそのもの」だけを見る。
 */

function makeArm(overrides = {}) {
  return {
    armLabel: "A: 擬似LLM+擬似埋め込み",
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    mrrOverall: 0.018,
    mrrLexicalControl: 0,
    mrrNonLexical: 0.021,
    hit1Count: 0,
    hit10Count: 1,
    probeCount: 7,
    ...overrides,
  };
}

describe("validateMeasured", () => {
  it("正しい形は ok:true を返す", () => {
    const result = validateMeasured({ arms: [makeArm()] });
    expect(result.ok).toBe(true);
  });

  it("オブジェクトでなければ落ちる", () => {
    expect(validateMeasured(null).ok).toBe(false);
    expect(validateMeasured("not an object").ok).toBe(false);
    expect(validateMeasured(42).ok).toBe(false);
  });

  it("arms が無ければ落ちる", () => {
    const result = validateMeasured({});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/arms/);
  });

  it("arms が空配列でも落ちる(measured は必ず arm を持つはず)", () => {
    const result = validateMeasured({ arms: [] });
    expect(result.ok).toBe(false);
  });

  it("arms が配列でなければ落ちる", () => {
    expect(validateMeasured({ arms: "not-an-array" }).ok).toBe(false);
  });

  for (const field of [
    "armLabel",
    "llmMode",
    "embeddingMode",
    "mrrOverall",
    "mrrLexicalControl",
    "mrrNonLexical",
    "hit1Count",
    "hit10Count",
    "probeCount",
  ]) {
    it(`arm から ${field} が欠けていれば落ちる`, () => {
      const arm = makeArm();
      delete arm[field];
      const result = validateMeasured({ arms: [arm] });
      expect(result.ok, `${field} が無いのに ok:true になった`).toBe(false);
      expect(result.error).toContain(field);
    });
  }

  it("数値項目が文字列など違う型なら落ちる", () => {
    const result = validateMeasured({ arms: [makeArm({ mrrOverall: "0.018" })] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("mrrOverall");
  });

  it("armLabel が空文字なら落ちる", () => {
    const result = validateMeasured({ arms: [makeArm({ armLabel: "" })] });
    expect(result.ok).toBe(false);
  });

  it("複数 arm のうち1件だけ壊れていても検出する", () => {
    const result = validateMeasured({ arms: [makeArm(), { ...makeArm(), hit1Count: undefined }] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("arms[1]");
  });
});

describe("validateBaseline", () => {
  it("正しい形は ok:true を返す", () => {
    expect(validateBaseline({ arms: [makeArm()] }).ok).toBe(true);
  });

  it("arms が空配列でも ok(基準値がまだ無い状態を許す)", () => {
    expect(validateBaseline({ arms: [] }).ok).toBe(true);
  });

  it("arms が無ければ落ちる", () => {
    expect(validateBaseline({}).ok).toBe(false);
  });

  it("arm の必須項目が欠けていれば落ちる", () => {
    const arm = makeArm();
    delete arm.mrrOverall;
    expect(validateBaseline({ arms: [arm] }).ok).toBe(false);
  });
});

describe("diffArm", () => {
  it("完全一致なら matches:true", () => {
    const arm = makeArm();
    const result = diffArm(arm, { ...arm });
    expect(result.matches).toBe(true);
    expect(result.fieldDiffs).toEqual([]);
  });

  it("基準値に対応する arm が無ければ missingBaseline:true", () => {
    const result = diffArm(makeArm(), undefined);
    expect(result.matches).toBe(false);
    expect(result.missingBaseline).toBe(true);
  });

  it("値が違う項目だけを fieldDiffs に載せる", () => {
    const measured = makeArm({ mrrOverall: 0.02, hit1Count: 1 });
    const baseline = makeArm();
    const result = diffArm(measured, baseline);
    expect(result.matches).toBe(false);
    const fields = result.fieldDiffs.map((d) => d.field).sort();
    expect(fields).toEqual(["hit1Count", "mrrOverall"]);
    const mrrDiff = result.fieldDiffs.find((d) => d.field === "mrrOverall");
    expect(mrrDiff).toEqual({ field: "mrrOverall", baseline: 0.018, measured: 0.02 });
  });

  it("armLabel 自体は比較対象に含めない(呼び出し側がラベルで対応付け済み)", () => {
    const measured = makeArm({ armLabel: "違うラベル" });
    const baseline = makeArm();
    const result = diffArm(measured, baseline);
    expect(result.fieldDiffs.some((d) => d.field === "armLabel")).toBe(false);
  });
});

describe("buildSummaryMarkdown", () => {
  const measured = {
    arms: [makeArm(), makeArm({ armLabel: "B", mrrOverall: 0.714, hit1Count: 4, hit10Count: 6 })],
  };

  it("arm・モード・MRR/hit@1/hit@10 が同一行に出る(ADR 0068 ②の形)", () => {
    const markdown = buildSummaryMarkdown({ measured });
    const rowA = markdown.split("\n").find((line) => line.includes("A: 擬似LLM+擬似埋め込み"));
    expect(rowA).toBeDefined();
    expect(rowA).toContain("deterministic");
    expect(rowA).toContain("0.018");
    expect(rowA).toContain("0/7");
    expect(rowA).toContain("1/7");
  });

  it("baseline を省略すると差分節そのものを出さない", () => {
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).not.toContain("基準値との差分");
  });

  it("baseline と一致すれば1行で済ませる", () => {
    const markdown = buildSummaryMarkdown({ measured, baseline: measured });
    expect(markdown).toContain("基準値との差分");
    expect(markdown).toContain("一致（差分なし）");
    expect(markdown).not.toContain("| 項目 | 基準値 | 実測 |");
  });

  it("baseline と相違すれば展開する", () => {
    const baseline = { arms: [makeArm({ mrrOverall: 0.02 }), measured.arms[1]] };
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("相違した arm が 1 件ある");
    expect(markdown).toContain("| 項目 | 基準値 | 実測 |");
    expect(markdown).toContain("mrrOverall");
  });

  it("3つの読み方の注意書きをすべて含む", () => {
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).toContain("similarity");
    expect(markdown).toContain("probe 7件");
    expect(markdown).toContain("否定・時制・矛盾");
  });
});

import { describe, expect, it } from "vitest";
import {
  analyzeWorkflowNames,
  classifyNameValue,
  findNameDeclarations,
} from "../workflow-name-comment-lib.mjs";

/**
 * `scripts/workflow-name-comment-lib.mjs` の境界の歯。
 *
 * ⭐ **この歯が測っているもの**: 「引用符の有無」と「`#` の直前が半角空白か全角文字か」の
 * 組み合わせを、合成した YAML 断片で機械的に確かめる。実物の `.github/workflows/**` に
 * この歯を当てるのは `scripts/__tests__/workflow-name-comment-wiring.test.mjs` であり、
 * ここでは重複しない——ここは lib の**判定ロジックそのもの**を、`ci.yml` を1バイトも
 * 読まずに測る(`lexical-regime-coverage-lib.test.mjs` と同じ分担)。
 *
 * ⭐ **境界の核心(`ci.yml:518` 型)**: `#` が在ることそのものではなく、「その直前が
 * YAML の空白(半角スペース/タブ)かどうか」で判定が変わる。全角の `（` は空白ではない
 * ——ここを取り違えると `ci.yml:518` のような健全な行を誤検出して赤くなる。
 */

describe("classifyNameValue — 境界の4形(依頼の表そのもの)", () => {
  it("① 引用符付き・# 在り → safe(引用符の中なのでコメントにならない)", () => {
    const result = classifyNameValue('"…値を残す（Issue #136）"');
    expect(result.status).toBe("safe");
  });

  it("② 引用符無し・# の直前が全角『（』→ safe(全角は YAML の空白ではない)", () => {
    const result = classifyNameValue("識別子・固有名詞 probe（#106）を実測し、値を残す");
    expect(result.status).toBe("safe");
  });

  it("③ 引用符無し・# の直前が半角空白 → truncated(黙って切れる、これが直したかった欠陥そのもの)", () => {
    const result = classifyNameValue(
      "Runtime.consolidate() が「載る量」に効くかを実測し、値を残す（Issue #136）",
    );
    expect(result.status).toBe("truncated");
    expect(result.kept).toBe("Runtime.consolidate() が「載る量」に効くかを実測し、値を残す（Issue");
  });

  it("④ 引用符無し・値の先頭が # → truncated(名前が空になる形。cutAt: 0)", () => {
    const result = classifyNameValue("#136 について実測する");
    expect(result.status).toBe("truncated");
    expect(result.cutAt).toBe(0);
    expect(result.kept).toBe("");
  });
});

describe("classifyNameValue — 引用符の境界", () => {
  it('二重引用符: エスケープされた \\" は閉じ引用符として扱わない', () => {
    const result = classifyNameValue('"値に \\"引用符\\" を含む #1"');
    expect(result.status).toBe("safe");
  });

  it("単一引用符: '' はエスケープされた1個の ' であり、閉じではない", () => {
    const result = classifyNameValue("'値に ''引用符'' を含む #1'");
    expect(result.status).toBe("safe");
  });

  it("単一引用符の中の # はコメントにならない", () => {
    const result = classifyNameValue("'値の中に #1 が在る'");
    expect(result.status).toBe("safe");
  });

  it("🔴 同じ行で閉じていない二重引用符 → unhandled(この実装は複数行の折り返しを扱わない)", () => {
    const result = classifyNameValue('"閉じていない値 #1');
    expect(result.status).toBe("unhandled");
    expect(result.reason).toBe("quoted-not-closed-on-same-line");
  });

  it("🔴 同じ行で閉じていない単一引用符 → unhandled", () => {
    const result = classifyNameValue("'閉じていない値 #1");
    expect(result.status).toBe("unhandled");
  });
});

describe("classifyNameValue — 扱えない形は黙って通さず unhandled にする", () => {
  it("🔴 block scalar(|) → unhandled", () => {
    expect(classifyNameValue("|").status).toBe("unhandled");
    expect(classifyNameValue("|-").status).toBe("unhandled");
  });

  it("🔴 block scalar(>) → unhandled", () => {
    expect(classifyNameValue(">").status).toBe("unhandled");
  });

  it("🔴 flow mapping({ … }) → unhandled", () => {
    expect(classifyNameValue("{ foo: bar }").status).toBe("unhandled");
  });

  it("🔴 空の inline 値(次の行に続くかもしれない形) → unhandled", () => {
    expect(classifyNameValue("").status).toBe("unhandled");
    expect(classifyNameValue("   ").status).toBe("unhandled");
  });
});

describe("classifyNameValue — # を含まない書き換えでは判定が動かない(変異試験(2)の裏付け)", () => {
  it("# を含まない部分をどう書き換えても safe のまま(値の中身を固定していないため)", () => {
    const before = classifyNameValue("識別子・固有名詞 probe（#106）を実測し、値を残す");
    const after = classifyNameValue("識別子・別名詞 probe（#106）を計測し、値を残す");
    expect(before.status).toBe("safe");
    expect(after.status).toBe("safe");
  });
});

describe("findNameDeclarations", () => {
  it("job 直下の name: / step の - name: / with: 直下の name: をすべて拾う", () => {
    const yaml = [
      "name: CI",
      "jobs:",
      "  build:",
      "    name: typecheck / lint",
      "    steps:",
      "      - name: Checkout",
      "        uses: actions/checkout@v4",
      "      - name: Upload",
      "        uses: actions/upload-artifact@v6",
      "        with:",
      "          name: some-artifact",
      "",
    ].join("\n");
    const declarations = findNameDeclarations(yaml);
    expect(declarations.map((d) => d.value)).toEqual([
      "CI",
      "typecheck / lint",
      "Checkout",
      "Upload",
      "some-artifact",
    ]);
    expect(declarations.map((d) => d.isStep)).toEqual([false, false, true, true, false]);
  });

  it("name: というキーではない行(例えば displayName:)を拾わない", () => {
    const yaml = ["    displayName: 何か", "    exposureName: 何か", ""].join("\n");
    expect(findNameDeclarations(yaml)).toHaveLength(0);
  });
});

describe("analyzeWorkflowNames", () => {
  it("宣言ごとに status を付けて返す(safe / truncated / unhandled が混在する断片)", () => {
    const yaml = [
      "jobs:",
      "  a:",
      '    name: "引用符の中の #1 は安全"',
      "    steps:",
      "      - name: 全角括弧（#2）は安全",
      "      - name: 半角空白 #3 は切れる",
      "",
    ].join("\n");
    const results = analyzeWorkflowNames(yaml, "fixture.yml");
    expect(results.map((r) => r.status)).toEqual(["safe", "safe", "truncated"]);
    expect(results.every((r) => r.fileLabel === "fixture.yml")).toBe(true);
  });
});

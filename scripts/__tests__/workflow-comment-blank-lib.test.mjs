import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * `scripts/workflow-comment-blank-lib.mjs` の境界の歯。
 *
 * ⭐ **この歯が測っているもの**: 合成した YAML/bash 断片に対して、
 * `blankOutWorkflowComments` が「YAML/bash のコメント規則」をどこまで正しく判定できるか、
 * そして「扱えない形」を黙って通さず `unhandled` として名乗るかを機械的に確かめる。
 * 実物の `ci.yml` にこの関数を当てた結果の固定は
 * `scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` /
 * `scripts/__tests__/ci-yml-postgres-regime-coverage-wiring.test.mjs` 側にある
 * (`lexical-regime-coverage-lib.test.mjs` と同じ分担——ここは ci.yml を1バイトも読まない)。
 */

describe("blankOutWorkflowComments — YAML の地の文のコメント", () => {
  it("行頭の # はコメントとして丸ごと潰す", () => {
    const source = "  # これはコメント\nkey: value\n";
    const { text, unhandled } = blankOutWorkflowComments(source);
    expect(text).not.toContain("これはコメント");
    expect(text).toContain("key: value");
    expect(unhandled).toEqual([]);
  });

  it("半角空白の直後の # はコメントを開始する(黙って切れる、ここが直したい欠陥そのもの)", () => {
    const source = 'if: always() # 常に走る\n';
    const { text } = blankOutWorkflowComments(source);
    expect(text).toContain("if: always()");
    expect(text).not.toContain("常に走る");
  });

  it("⚠ 全角文字の直後の # はコメントではない(ci.yml:518 型)", () => {
    const source = "name: 識別子・固有名詞 probe（#106）を実測する\n";
    const { text, unhandled } = blankOutWorkflowComments(source);
    expect(text).toBe(source);
    expect(unhandled).toEqual([]);
  });

  it("二重引用符の中の # はコメントにならない", () => {
    const source = '  echo "測れない（Issue #155）" >&2\n';
    const { text } = blankOutWorkflowComments(source);
    expect(text).toContain("測れない（Issue #155）");
  });

  it("二重引用符: エスケープされた \\\" は閉じ引用符として扱わない", () => {
    const source = '  echo "値に \\"引用符\\" を含む #1" >&2\n';
    const { text, unhandled } = blankOutWorkflowComments(source);
    expect(text).toContain("値に \\\"引用符\\\" を含む #1");
    expect(unhandled).toEqual([]);
  });

  it("単一引用符の中の # はコメントにならない(bash の規則: 次の ' で閉じる)", () => {
    const source = "  echo '値の中に #1 が在る'\n";
    const { text } = blankOutWorkflowComments(source);
    expect(text).toContain("値の中に #1 が在る");
  });
});

describe("blankOutWorkflowComments — 変異D/H と同じ形(実害の再現)", () => {
  it("`exit 1` が `: # exit 1` に変異すると、潰したあとには `exit 1` が残らない(変異D)", () => {
    const before = "            exit 1\n";
    const after = "            : # exit 1\n";
    expect(blankOutWorkflowComments(before).text).toContain("exit 1");
    expect(blankOutWorkflowComments(after).text).not.toContain("exit 1");
  });

  it("`if: always()` が `if: success()` に変異すると、地の文のコメント中の引用は残るが実キーは変わる(変異H)", () => {
    const before = [
      "        # このステップは常に走る(`if: always()`)——上の test:db が",
      "        if: always()",
      "",
    ].join("\n");
    const after = [
      "        # このステップは常に走る(`if: always()`)——上の test:db が",
      "        if: success()",
      "",
    ].join("\n");
    // コメント行自体は(コメントなので)潰れて消える。実キーの行だけが両者を分ける。
    const beforeBlanked = blankOutWorkflowComments(before).text;
    const afterBlanked = blankOutWorkflowComments(after).text;
    expect(beforeBlanked).toContain("if: always()");
    expect(afterBlanked).not.toContain("if: always()");
  });
});

describe("blankOutWorkflowComments — 扱えない形は黙って通さず unhandled にする", () => {
  it("同じ行で閉じない二重引用符 → unhandled(潰さずそのまま返す)", () => {
    const source = '  echo "閉じていない #1\n';
    const { text, unhandled } = blankOutWorkflowComments(source);
    expect(text).toBe(source);
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0].reason).toBe("quote-not-closed-on-same-line");
  });

  it("`''`(単一引用符が連続する)は YAML と bash で規則が違うため unhandled", () => {
    const source = "name: '値に ''引用符'' を含む #1'\n";
    const { unhandled } = blankOutWorkflowComments(source);
    expect(unhandled.some((u) => u.reason === "ambiguous-double-single-quote")).toBe(true);
  });

  it("ヒアドキュメントは本体ごと unhandled にし、本体を潰さない", () => {
    const source = [
      "run: |",
      "  cat <<EOF",
      "  name: dummy #123",
      "  EOF",
      "",
    ].join("\n");
    const { text, unhandled } = blankOutWorkflowComments(source);
    expect(text).toContain("name: dummy #123");
    expect(unhandled.some((u) => u.reason === "heredoc-body-unhandled")).toBe(true);
  });

  it("ヒアドキュメントの終端が見つからない(ファイル末尾まで) → unhandled", () => {
    const source = ["run: |", "  cat <<EOF", "  name: dummy #123", ""].join("\n");
    const { unhandled } = blankOutWorkflowComments(source);
    expect(unhandled.some((u) => u.reason === "heredoc-terminator-not-found")).toBe(true);
  });
});

describe("blankOutWorkflowComments 自体が効いていること(⭐ この可視化が壊れても気づけるため)", () => {
  // 🔴 この describe が無いと、`blankOutWorkflowComments` が将来「何も潰さない」実装に
  // 退化しても誰も気づかない(`ci-yml-postgres-regime-wiring.test.mjs` の
  // `blankOutComments 自体が効いていること` と同じ思想のメタ歯)。

  it("コメントにだけ在る文字列は、潰したあと残らない", () => {
    const source = ["# exit 1 はコメントにだけ在る", "key: value", ""].join("\n");
    expect(source, "前提: 素のソースには在る").toContain("exit 1");
    expect(
      blankOutWorkflowComments(source).text,
      "コメントにだけ在る文字列が潰されていない——素のソースへ当てるのと同じことになる",
    ).not.toContain("exit 1");
  });

  it("コードに在る文字列は、潰しても残る", () => {
    const source = ["# exit 1 の説明", "            exit 1", ""].join("\n");
    expect(blankOutWorkflowComments(source).text).toContain("exit 1");
  });

  it("引用符の中の # は潰さない", () => {
    const source = 'echo "https://example.invalid/ok#fragment" >&2\n';
    expect(blankOutWorkflowComments(source).text).toContain(
      "https://example.invalid/ok#fragment",
    );
  });

  it("添字が元のソースと一致する(順序の固定が壊れないための性質)", () => {
    const source = ["if: always() # 消える", 'echo "残る #1" >&2', ""].join("\n");
    const { text } = blankOutWorkflowComments(source);
    expect(text).toHaveLength(source.length);
    expect(text.indexOf('echo "残る')).toBe(source.indexOf('echo "残る'));
  });

  it("行数が変わらない(改行を残している)", () => {
    const source = ["# 1行目のコメント", "key: value # 2行目のコメント", "", ""].join("\n");
    const countLines = (text) => text.split("\n").length;
    expect(countLines(blankOutWorkflowComments(source).text)).toBe(countLines(source));
  });
});

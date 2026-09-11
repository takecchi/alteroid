import { describe, expect, it } from "vitest";
import { buildSummaryMarkdown, validateMeasured } from "../lexical-regime-summary-lib.mjs";

/**
 * `lexical-regime-summary-lib.mjs`(純関数の側)の歯。DB を要求しない
 * ——`consolidation-cost-summary-lib.test.mjs`/`identifier-probe-summary-lib.test.mjs`
 * と同じ分担・同じ理由(Issue #148)。
 *
 * 🔴 **ここで固定する一番大事な性質**: `validateMeasured` は regime の値
 * (`server_encoding`/`nonAsciiIsIndexed` がどちらか)を一切見ない。検査するのは
 * 「値が空・欠けていないか」という構造だけであり、**これは値の門ではない**。
 */

function makeValid(overrides = {}) {
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-12T00:00:00.000Z",
    serverVersion: "PostgreSQL 17.11",
    serverEncoding: "UTF8",
    nonAsciiIsIndexed: true,
    rawTsvector: "'1234':2 '四半期レビューでproj':1",
    rawIdentifierHit: false,
    rawJapaneseWordHit: false,
    regime: "non_ascii_indexed",
    ...overrides,
  };
}

describe("validateMeasured", () => {
  it("正しい形なら ok: true を返す", () => {
    const result = validateMeasured(makeValid());
    expect(result.ok).toBe(true);
  });

  it("オブジェクトでなければ ok: false", () => {
    expect(validateMeasured(null).ok).toBe(false);
    expect(validateMeasured("not an object").ok).toBe(false);
    expect(validateMeasured(42).ok).toBe(false);
  });

  it("🔴 serverEncoding が空文字だと ok: false(『値が空だった』を検出する経路)", () => {
    const result = validateMeasured(makeValid({ serverEncoding: "" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("serverEncoding");
  });

  it("serverVersion が空文字だと ok: false", () => {
    const result = validateMeasured(makeValid({ serverVersion: "" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("serverVersion");
  });

  it("鍵が欠けている(nonAsciiIsIndexed が無い)と ok: false", () => {
    const data = makeValid();
    delete data.nonAsciiIsIndexed;
    const result = validateMeasured(data);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("nonAsciiIsIndexed");
  });

  it("nonAsciiIsIndexed が真偽値でないと ok: false", () => {
    const result = validateMeasured(makeValid({ nonAsciiIsIndexed: "true" }));
    expect(result.ok).toBe(false);
  });

  it("🔴 nonAsciiIsIndexed が true でも false でも、それだけでは ok: false にならない(値の門ではない)", () => {
    expect(validateMeasured(makeValid({ nonAsciiIsIndexed: true })).ok).toBe(true);
    expect(
      validateMeasured(
        makeValid({
          nonAsciiIsIndexed: false,
          regime: "non_ascii_dropped",
          rawIdentifierHit: true,
        }),
      ).ok,
    ).toBe(true);
  });

  it("🔴 serverEncoding が SQL_ASCII でも UTF8 でも、それだけでは ok: false にならない", () => {
    expect(validateMeasured(makeValid({ serverEncoding: "SQL_ASCII" })).ok).toBe(true);
    expect(validateMeasured(makeValid({ serverEncoding: "UTF8" })).ok).toBe(true);
  });
});

describe("buildSummaryMarkdown", () => {
  it("server_version / server_encoding / nonAsciiIsIndexed / regime を出す", () => {
    const markdown = buildSummaryMarkdown(makeValid());
    expect(markdown).toContain("PostgreSQL 17.11");
    expect(markdown).toContain("UTF8");
    expect(markdown).toContain("nonAsciiIsIndexed");
    expect(markdown).toContain("non_ascii_indexed");
  });

  it("🔴 『門ではない』ことを明示する文言を含む", () => {
    const markdown = buildSummaryMarkdown(makeValid());
    expect(markdown).toContain("門ではない");
  });

  it("生の tsvector を出す", () => {
    const markdown = buildSummaryMarkdown(makeValid());
    expect(markdown).toContain("'1234':2");
  });

  it("regime が non_ascii_dropped のときも同じ形で出る(良し悪しを言わない)", () => {
    const markdown = buildSummaryMarkdown(
      makeValid({ nonAsciiIsIndexed: false, regime: "non_ascii_dropped", rawIdentifierHit: true }),
    );
    expect(markdown).toContain("non_ascii_dropped");
    expect(markdown).toContain("門ではない");
  });
});

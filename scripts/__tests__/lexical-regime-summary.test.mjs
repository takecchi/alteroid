import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/lexical-regime-summary.mjs` の歯。**本物のスクリプトを子プロセスとして
 * 実際に起動する**(`consolidation-cost-summary.test.mjs` と同じ判断)
 * ——`lexical-regime-summary-lib.test.mjs` は純関数だけを見ており、
 * 「CLI としての配線」(引数の読み方・ファイル I/O・exit code・**3種の非0経路の
 * メッセージが実際に別れているか**)はここでしか測れない。
 *
 * DB は要求しない——このスクリプトは JSON ファイル1個を読むだけである(Issue #148)。
 *
 * 🔴 **このファイルが固定している線**:
 *
 * 1. **server_encoding/nonAsciiIsIndexed がどちらでも exit 0**(⛔ 良し悪しの門ではない
 *    ——ただし宣言(`--expect-encoding`)と一致していること)。
 * 2. **ファイルが無い(ENOENT)→非0**、かつそのメッセージは「値が出ていない」側の文言。
 * 3. **JSON の parse に失敗→非0**、かつそのメッセージは(2)とも(4)とも異なる。
 * 4. **値が空だった(必須項目が空・欠落)→非0**、かつそのメッセージは(2)とも異なる
 *    ——「値が出ていない」と「値が空だった」は別のメッセージである、という
 *    Issue #148 の受け入れ基準そのもの。
 * 5. **🔴 Issue #148 ②: `--expect-encoding` が無いと非0(exit 1)。**
 * 6. **🔴 宣言と実測が食い違うと非0——ただし Markdown は先に stdout へ出ている
 *    (順序の固定点。`lexical-regime-summary.mjs` の docstring)。**
 */

const script = fileURLToPath(new URL("../lexical-regime-summary.mjs", import.meta.url));

function makeValid(overrides = {}) {
  return {
    schemaVersion: 2,
    measuredAt: "2026-09-12T00:00:00.000Z",
    serverVersion: "PostgreSQL 17.11",
    serverEncoding: "UTF8",
    nonAsciiIsIndexed: true,
    rawTsvector: "'1234':2 '四半期レビューでproj':1",
    rawIdentifierHit: false,
    rawJapaneseWordHit: false,
    regime: "non_ascii_indexed",
    lcCollate: "en_US.UTF-8",
    lcCtype: "en_US.UTF-8",
    defaultTextSearchConfig: "pg_catalog.simple",
    ...overrides,
  };
}

let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function writeJson(name, data) {
  workDir ??= mkdtempSync(join(tmpdir(), "lexical-regime-summary-"));
  const path = join(workDir, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("lexical-regime-summary.mjs(子プロセスで起動)", () => {
  it("正常な JSON なら exit 0 で、server_encoding / server_version を出す", () => {
    const measuredPath = writeJson("measured.json", makeValid());
    const result = run(["--measured", measuredPath, "--expect-encoding", "UTF8"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("server_encoding");
    expect(result.stdout).toContain("server_version");
    expect(result.stdout).toContain("UTF8");
  });

  it("🔴 nonAsciiIsIndexed が true でも false でも exit 0(⛔ 値の良し悪しの門ではないことの固定点。宣言は一致させる)", () => {
    const truePath = writeJson("true.json", makeValid({ nonAsciiIsIndexed: true }));
    expect(run(["--measured", truePath, "--expect-encoding", "UTF8"]).status).toBe(0);

    const falsePath = writeJson(
      "false.json",
      makeValid({
        nonAsciiIsIndexed: false,
        regime: "non_ascii_dropped",
        rawIdentifierHit: true,
        serverEncoding: "SQL_ASCII",
      }),
    );
    expect(run(["--measured", falsePath, "--expect-encoding", "SQL_ASCII"]).status).toBe(0);
  });

  it("🔴 serverEncoding が SQL_ASCII でも、宣言が一致していれば exit 0(値そのものを門にしていないことの固定点)", () => {
    const path = writeJson("sql-ascii.json", makeValid({ serverEncoding: "SQL_ASCII" }));
    const result = run(["--measured", path, "--expect-encoding", "SQL_ASCII"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SQL_ASCII");
  });

  it("--measured を渡さないと非0", () => {
    const result = run(["--expect-encoding", "UTF8"]);
    expect(result.status).not.toBe(0);
  });

  it("🔴 Issue #148 ②: --expect-encoding を渡さないと非0", () => {
    const measuredPath = writeJson("measured.json", makeValid());
    const result = run(["--measured", measuredPath]);
    expect(result.status).not.toBe(0);
  });

  it("🔴 --measured のパスが存在しないと非0で、『値が出ていない』側の文言が出る", () => {
    const result = run([
      "--measured",
      join(tmpdir(), "does-not-exist-lexical-regime.json"),
      "--expect-encoding",
      "UTF8",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/出ていない/);
  });

  it("🔴 中身が壊れた JSON(構文エラー)だと非0で、parse 失敗の文言が出る", () => {
    const measuredPath = writeJson("broken.json", "{ this is not json");
    const result = run(["--measured", measuredPath, "--expect-encoding", "UTF8"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/parse/);
  });

  it("🔴 必須項目が空文字だと非0で、『値が空だった』側の文言が出る", () => {
    const measuredPath = writeJson("empty.json", makeValid({ serverEncoding: "" }));
    const result = run(["--measured", measuredPath, "--expect-encoding", "UTF8"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/空だった/);
  });

  it("🔴 必須項目が欠けていると非0で、『値が空だった』側の文言が出る", () => {
    const measured = makeValid();
    delete measured.serverVersion;
    const measuredPath = writeJson("missing-field.json", measured);
    const result = run(["--measured", measuredPath, "--expect-encoding", "UTF8"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/空だった/);
    expect(result.stderr).toContain("serverVersion");
  });

  it("⭐ 『ファイルが無い』と『値が空だった』は異なるメッセージである", () => {
    const missing = run([
      "--measured",
      join(tmpdir(), "does-not-exist-lexical-regime-2.json"),
      "--expect-encoding",
      "UTF8",
    ]);
    const emptyPath = writeJson("empty2.json", makeValid({ serverVersion: "" }));
    const empty = run(["--measured", emptyPath, "--expect-encoding", "UTF8"]);
    expect(missing.status).not.toBe(0);
    expect(empty.status).not.toBe(0);
    expect(missing.stderr).not.toBe(empty.stderr);
    expect(missing.stderr).toMatch(/出ていない/);
    expect(empty.stderr).toMatch(/空だった/);
  });

  it("⭐ 『ファイルが無い』と『JSON が壊れている』も異なるメッセージである", () => {
    const missing = run([
      "--measured",
      join(tmpdir(), "does-not-exist-lexical-regime-3.json"),
      "--expect-encoding",
      "UTF8",
    ]);
    const brokenPath = writeJson("broken2.json", "not json at all");
    const broken = run(["--measured", brokenPath, "--expect-encoding", "UTF8"]);
    expect(missing.stderr).not.toBe(broken.stderr);
  });

  it("基準値ファイルは要求しない(--baseline のようなオプションを持たない)", () => {
    const measuredPath = writeJson("measured.json", makeValid());
    const result = run(["--measured", measuredPath, "--expect-encoding", "UTF8"]);
    expect(result.status, result.stderr).toBe(0);
  });

  // 🔴 Issue #148 ②: 宣言(--expect-encoding)と実測(serverEncoding)の突き合わせ。
  describe("宣言と実測の突き合わせ", () => {
    it("一致していれば exit 0", () => {
      const measuredPath = writeJson("match.json", makeValid({ serverEncoding: "UTF8" }));
      const result = run(["--measured", measuredPath, "--expect-encoding", "UTF8"]);
      expect(result.status, result.stderr).toBe(0);
    });

    it("🔴 食い違えば exit 1", () => {
      const measuredPath = writeJson("mismatch.json", makeValid({ serverEncoding: "SQL_ASCII" }));
      const result = run(["--measured", measuredPath, "--expect-encoding", "UTF8"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("UTF8");
      expect(result.stderr).toContain("SQL_ASCII");
    });

    it("⭐ 食い違って exit 1 でも、Markdown はすでに stdout に出ている(順序の固定点)", () => {
      const measuredPath = writeJson("mismatch2.json", makeValid({ serverEncoding: "SQL_ASCII" }));
      const result = run(["--measured", measuredPath, "--expect-encoding", "UTF8"]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("server_encoding");
      expect(result.stdout).toContain("SQL_ASCII");
    });
  });
});

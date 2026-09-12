import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/lexical-regime-coverage.mjs` の歯。**本物のスクリプトを子プロセスとして
 * 実際に起動する**(`lexical-regime-summary.test.mjs` と同じ判断)——CLI としての
 * 配線(`--artifacts-dir` の読み方・ファイル探索・exit code)は
 * `lexical-regime-coverage-lib.test.mjs`(純関数のみ)では測れない。
 */

const script = fileURLToPath(new URL("../lexical-regime-coverage.mjs", import.meta.url));

let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function makeArtifactsDir() {
  workDir ??= mkdtempSync(join(tmpdir(), "lexical-regime-coverage-"));
  return workDir;
}

function writeArtifact(artifactsDir, encoding, data) {
  const dir = join(artifactsDir, `lexical-regime-${encoding}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "lexical-regime.json"),
    typeof data === "string" ? data : JSON.stringify(data),
  );
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function makeRegime(serverEncoding) {
  return {
    schemaVersion: 2,
    measuredAt: "2026-09-12T00:00:00.000Z",
    serverVersion: "PostgreSQL 17.11",
    serverEncoding,
    nonAsciiIsIndexed: serverEncoding === "UTF8",
    rawTsvector: "x",
    rawIdentifierHit: false,
    rawJapaneseWordHit: false,
    regime: serverEncoding === "UTF8" ? "non_ascii_indexed" : "non_ascii_dropped",
    lcCollate: "en_US.UTF-8",
    lcCtype: "en_US.UTF-8",
    defaultTextSearchConfig: "pg_catalog.simple",
  };
}

describe("lexical-regime-coverage.mjs(子プロセスで起動)", () => {
  it("⭐ UTF8 / SQL_ASCII の両方が名前どおりに揃っていれば exit 0(3脚目を要求しない)", () => {
    const dir = makeArtifactsDir();
    writeArtifact(dir, "UTF8", makeRegime("UTF8"));
    writeArtifact(dir, "SQL_ASCII", makeRegime("SQL_ASCII"));
    const result = run(["--artifacts-dir", dir]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("✅");
  });

  it("🔴 --artifacts-dir を渡さないと非0", () => {
    const result = run([]);
    expect(result.status).not.toBe(0);
  });

  it("🔴 SQL_ASCII の artifact が無いと非0", () => {
    const dir = makeArtifactsDir();
    writeArtifact(dir, "UTF8", makeRegime("UTF8"));
    const result = run(["--artifacts-dir", dir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("lexical-regime-SQL_ASCII");
  });

  it("🔴 存在しないディレクトリを渡しても(何も見つからない扱いで)非0", () => {
    const result = run(["--artifacts-dir", join(tmpdir(), "does-not-exist-coverage-dir")]);
    expect(result.status).not.toBe(0);
  });

  it("🔴 両方揃っているが中身が両方 UTF8 だと非0(POSTGRES_INITDB_ARGS が効いていない疑い)", () => {
    const dir = makeArtifactsDir();
    writeArtifact(dir, "UTF8", makeRegime("UTF8"));
    // SQL_ASCII という名前の artifact なのに、中身は UTF8 を測っている
    // (initdb の宣言が無視された場合に実際に起きうる形)。
    writeArtifact(dir, "SQL_ASCII", makeRegime("UTF8"));
    const result = run(["--artifacts-dir", dir]);
    expect(result.status).not.toBe(0);
  });

  it("🔴 JSON が壊れていると非0", () => {
    const dir = makeArtifactsDir();
    writeArtifact(dir, "UTF8", makeRegime("UTF8"));
    writeArtifact(dir, "SQL_ASCII", "{ これは JSON ではない");
    const result = run(["--artifacts-dir", dir]);
    expect(result.status).not.toBe(0);
  });

  it("⭐ 非0のときも Markdown はすでに stdout に出ている(順序の固定点)", () => {
    const dir = makeArtifactsDir();
    writeArtifact(dir, "UTF8", makeRegime("UTF8"));
    const result = run(["--artifacts-dir", dir]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("lexical-regime-UTF8");
  });
});

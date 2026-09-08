import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/decide-publish-dry-run.mjs`（`.github/workflows/publish.yml` の CLI 入口）の歯。
 *
 * `scripts/__tests__/publish-dry-run.test.mjs` は判定関数 `decideDryRun()` を直接検査するが、
 * ここでは**本物のスクリプトを子プロセスとして起動し**、workflow が実際に依拠する2点——
 *
 * 1. `$GITHUB_OUTPUT` に `dry_run=true`/`dry_run=false` が書かれること
 * 2. 想定外の入力のときだけ stdout に `::warning::` が出ること（5番目の固定対象）
 *
 * を測る。差し替えず本物を起動するのは `scripts/__tests__/run-db-tests.test.mjs` と
 * 同じ理由——「CLI がその通りに配線されているか」は、判定関数だけを見ていては分からない。
 */

const script = fileURLToPath(new URL("../decide-publish-dry-run.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** @type {string | undefined} */
let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function run({ eventName, dryRunInput }) {
  workDir = mkdtempSync(join(tmpdir(), "decide-publish-dry-run-"));
  const githubOutput = join(workDir, "github_output");
  writeFileSync(githubOutput, "");

  const env = { ...process.env, EVENT_NAME: eventName, GITHUB_OUTPUT: githubOutput };
  if (dryRunInput === undefined) {
    delete env.DRY_RUN_INPUT;
  } else {
    env.DRY_RUN_INPUT = dryRunInput;
  }

  const result = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8", env });
  const output = readFileSync(githubOutput, "utf8");
  return { result, output };
}

describe("scripts/decide-publish-dry-run.mjs（CLI として起動したときの配線）", () => {
  it('workflow_dispatch × dry_run="true" ⟹ GITHUB_OUTPUT に dry_run=true、警告なし', () => {
    const { result, output } = run({ eventName: "workflow_dispatch", dryRunInput: "true" });
    expect(result.status).toBe(0);
    expect(output).toContain("dry_run=true");
    expect(result.stdout).not.toContain("::warning::");
  });

  it('workflow_dispatch × dry_run="false" ⟹ GITHUB_OUTPUT に dry_run=false、警告なし', () => {
    const { result, output } = run({ eventName: "workflow_dispatch", dryRunInput: "false" });
    expect(result.status).toBe(0);
    expect(output).toContain("dry_run=false");
    expect(result.stdout).not.toContain("::warning::");
  });

  it("release ⟹ dry_run の値によらず GITHUB_OUTPUT に dry_run=false、警告なし", () => {
    const { result, output } = run({ eventName: "release", dryRunInput: undefined });
    expect(result.status).toBe(0);
    expect(output).toContain("dry_run=false");
    expect(result.stdout).not.toContain("::warning::");
  });

  /**
   * ⭐⭐ 芯（3番目 + 5番目）。想定外の値のときだけ、予行に倒れ、かつ ::warning:: が出ること。
   */
  it("workflow_dispatch × 想定外の dry_run ⟹ GITHUB_OUTPUT に dry_run=true、::warning:: が出る", () => {
    const { result, output } = run({ eventName: "workflow_dispatch", dryRunInput: "" });
    expect(result.status).toBe(0);
    expect(output).toContain("dry_run=true");
    expect(result.stdout).toContain("::warning::");
    expect(result.stdout).toContain("dry_run");
  });

  it("workflow_dispatch × dry_run 未定義（env に無い）⟹ dry_run=true・::warning:: が出る", () => {
    const { result, output } = run({ eventName: "workflow_dispatch", dryRunInput: undefined });
    expect(result.status).toBe(0);
    expect(output).toContain("dry_run=true");
    expect(result.stdout).toContain("::warning::");
  });
});

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLISH_TARGETS } from "../publish-targets.mjs";

/**
 * `scripts/apply-release-version.mjs` の歯（ADR 0070）。
 *
 * **なぜ CLI を子プロセスとして起動するか**: 判定そのものは
 * `scripts/__tests__/release-version.test.mjs` が純関数を直接測っている。
 * ここで測りたいのは**その先**——実際に `package.json` が書き換わること、
 * `$GITHUB_OUTPUT` に値が出ること、semver でない tag で EXIT=1 になることである。
 * これらは import では測れない（`process.exit` と実ファイルの書き込みを伴う）。
 *
 * **⚠ 本物の `packages/<pkg>/package.json` は書き換えない。**リポジトリを丸ごと
 * 一時ディレクトリへ複製し、そちらに対して走らせる——**歯が作業ツリーを汚さない。**
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** @type {string | undefined} */
let sandbox;

afterEach(() => {
  if (sandbox) {
    rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
});

/** リポジトリのうち、この段が触る範囲だけを一時ディレクトリへ複製する。 */
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "apply-release-version-"));
  cpSync(join(repoRoot, "scripts"), join(dir, "scripts"), { recursive: true });
  for (const target of PUBLISH_TARGETS) {
    cpSync(join(repoRoot, target.dir, "package.json"), join(dir, target.dir, "package.json"), {
      recursive: false,
      force: true,
      // 中間ディレクトリを作る
      ...{},
    });
  }
  return dir;
}

/** サンドボックス内で CLI を走らせる。 */
function run(dir, env) {
  const outputPath = join(dir, "github-output");
  writeFileSync(outputPath, "");
  const result = spawnSync(process.execPath, [join(dir, "scripts", "apply-release-version.mjs")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: outputPath, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    githubOutput: readFileSync(outputPath, "utf8"),
  };
}

function versionsIn(dir) {
  return PUBLISH_TARGETS.map(
    (t) => JSON.parse(readFileSync(join(dir, t.dir, "package.json"), "utf8")).version,
  );
}

describe("apply-release-version.mjs（ADR 0070）", () => {
  it("4パッケージの version を tag の版へ書き換える", () => {
    sandbox = makeSandbox();
    const before = versionsIn(sandbox);

    const r = run(sandbox, { RELEASE_TAG: "v9.9.9", GITHUB_PRERELEASE: "false" });

    expect(r.status, `EXIT=0 を期待した。stderr:\n${r.stderr}`).toBe(0);
    expect(versionsIn(sandbox)).toEqual(["9.9.9", "9.9.9", "9.9.9", "9.9.9"]);
    // 「元から 9.9.9 だったから通った」ではないことを確かめる
    expect(before).not.toEqual(["9.9.9", "9.9.9", "9.9.9", "9.9.9"]);
  });

  it("$GITHUB_OUTPUT へ version と npm_tag を書く", () => {
    sandbox = makeSandbox();
    const r = run(sandbox, { RELEASE_TAG: "v9.9.9", GITHUB_PRERELEASE: "false" });
    expect(r.githubOutput).toContain("version=9.9.9");
    expect(r.githubOutput).toContain("npm_tag=latest");
  });

  it("pre-release の Release では npm_tag が next になる", () => {
    sandbox = makeSandbox();
    const r = run(sandbox, { RELEASE_TAG: "v9.9.9", GITHUB_PRERELEASE: "true" });
    expect(r.githubOutput).toContain("npm_tag=next");
    expect(r.stdout).toContain("::warning::");
  });

  /**
   * ⭐ これがこの段を置いた理由そのものである。
   * `${TAG#v}` だけの実装だと `vfoo` が `foo` として書き込まれ、
   * `mnemora-core-foo.tgz` が publish の直前まで誰にも気づかれずに作られる。
   */
  it("semver でない tag では EXIT=1 になり、package.json を書き換えない", () => {
    sandbox = makeSandbox();
    const before = versionsIn(sandbox);

    const r = run(sandbox, { RELEASE_TAG: "vfoo", GITHUB_PRERELEASE: "false" });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::");
    expect(versionsIn(sandbox), "落ちたのに書き換わっていた").toEqual(before);
  });

  it("RELEASE_TAG が無ければ EXIT=1 になる", () => {
    sandbox = makeSandbox();
    const r = run(sandbox, { RELEASE_TAG: "" });
    expect(r.status).toBe(1);
  });

  it("同じ版で2回走らせても同じ結果になる（冪等）", () => {
    sandbox = makeSandbox();
    run(sandbox, { RELEASE_TAG: "v9.9.9", GITHUB_PRERELEASE: "false" });
    const once = versionsIn(sandbox);
    const r = run(sandbox, { RELEASE_TAG: "v9.9.9", GITHUB_PRERELEASE: "false" });
    expect(r.status).toBe(0);
    expect(versionsIn(sandbox)).toEqual(once);
  });

  /**
   * 書いた結果が prettier の整形と食い違うと、後段の `pnpm run format:check` が赤くなる
   * （workflow はこの段のあとに門を通す）。**JSON.stringify の整形がそれと一致することを固定する。**
   */
  it("書き換えた package.json が prettier の整形と一致する", () => {
    sandbox = makeSandbox();
    run(sandbox, { RELEASE_TAG: "v9.9.9", GITHUB_PRERELEASE: "false" });

    for (const target of PUBLISH_TARGETS) {
      const path = join(sandbox, target.dir, "package.json");
      const written = readFileSync(path, "utf8");
      const check = spawnSync(
        process.execPath,
        [
          join(repoRoot, "node_modules", "prettier", "bin", "prettier.cjs"),
          // ⚠ --parser json ではない。prettier は **package.json には json-stringify
          // パーサを使う**（`prettier --file-info` で確認した）。json パーサは
          // `"files": ["dist"]` と1行に畳むが、json-stringify は畳まない。
          // ⟹ --parser json で比べると、正しい出力を「違う」と誤判定する。
          "--stdin-filepath",
          "package.json",
        ],
        { input: written, encoding: "utf8" },
      );
      expect(check.status, `prettier が走らなかった: ${check.stderr}`).toBe(0);
      expect(check.stdout, `${target.name} の整形が prettier と違う`).toBe(written);
    }
  });
});

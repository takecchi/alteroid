import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tryGitRevParseHead } from "../git-info.js";

/**
 * `tryGitRevParseHead` の歯。DB を要求しない——`git` バイナリとファイルシステムだけを使う。
 */
describe("tryGitRevParseHead", () => {
  let workDir: string | undefined;

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
  });

  it("この repo の中で呼べば 40桁の16進文字列を返す(この repo は git 管理下にある)", () => {
    const sha = tryGitRevParseHead(process.cwd());
    expect(sha).not.toBeNull();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("git 管理下にないディレクトリでは null を返す(推測で埋めない)", () => {
    // ⚠ /tmp 自体が広い git リポジトリの中に置かれている環境は想定していないが、
    // OS の一時ディレクトリの直下は通常そうなっていない。
    workDir = mkdtempSync(join(tmpdir(), "git-info-test-"));
    const sha = tryGitRevParseHead(workDir);
    expect(sha).toBeNull();
  });

  it("存在しないディレクトリを渡しても例外にせず null を返す", () => {
    const sha = tryGitRevParseHead("/does/not/exist/at/all/hopefully");
    expect(sha).toBeNull();
  });
});

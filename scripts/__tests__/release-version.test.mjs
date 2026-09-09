import { describe, expect, it } from "vitest";
import { distTagFor, versionFromTag } from "../release-version.mjs";

/**
 * `scripts/release-version.mjs` の歯（ADR 0070）。
 *
 * 各歯は**対で書く**——壊した入力が実際に落ちることを確かめないかぎり、
 * 直した入力が通ることに意味は無い（このリポジトリの既存の歯と同じ作法）。
 */

describe("versionFromTag（ADR 0070）", () => {
  it("v0.1.2 から 0.1.2 を取り出す", () => {
    expect(versionFromTag("v0.1.2")).toEqual({ ok: true, version: "0.1.2" });
  });

  it("prerelease 付きの tag も通す", () => {
    expect(versionFromTag("v0.2.0-beta.1")).toEqual({ ok: true, version: "0.2.0-beta.1" });
  });

  it("build metadata 付きの tag も通す", () => {
    expect(versionFromTag("v1.0.0+build.5")).toEqual({ ok: true, version: "1.0.0+build.5" });
  });

  /**
   * ⭐ これがこの歯の芯である。
   *
   * shell の `${TAG#v}` は `vfoo` を `foo` にする。それが `package.json` に書き込まれ、
   * **`pnpm pack` は文句を言わずに `mnemora-core-foo.tgz` を作る**——publish の直前まで
   * 誰も気づかない。ここで落とすのは、その静かな壊れ方を止めるためである。
   */
  it("semver でない tag を落とす", () => {
    for (const bad of ["vfoo", "v1", "v1.2", "v1.2.3.4", "v01.2.3", "v-1.0.0", "v1.2.3-"]) {
      const result = versionFromTag(bad);
      expect(result.ok, `${bad} は落ちるべき`).toBe(false);
    }
  });

  it("v で始まらない tag を落とす", () => {
    const result = versionFromTag("0.1.2");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('"v"');
  });

  it("空・undefined・文字列でないものを落とす", () => {
    for (const bad of ["", undefined, null, 12, {}]) {
      expect(versionFromTag(bad).ok, `${JSON.stringify(bad)} は落ちるべき`).toBe(false);
    }
  });
});

describe("distTagFor（ADR 0070）", () => {
  it("通常の版・通常の Release は latest", () => {
    const r = distTagFor({ version: "0.1.2", githubPrerelease: false });
    expect(r.npmTag).toBe("latest");
    expect(r.warnings).toEqual([]);
  });

  it("GitHub 側で pre-release にした Release は next", () => {
    const r = distTagFor({ version: "0.1.2", githubPrerelease: true });
    expect(r.npmTag).toBe("next");
    expect(r.warnings).toHaveLength(1);
  });

  it("semver が prerelease なら、GitHub 側のチェックが無くても next", () => {
    const r = distTagFor({ version: "0.2.0-beta.1", githubPrerelease: false });
    expect(r.npmTag).toBe("next");
    expect(r.warnings).toHaveLength(1);
  });

  /**
   * 両方が prerelease を指しているときは食い違いが無いので警告は出ない。
   * **警告が出る条件と出ない条件を対で押さえる**——常に警告を出す実装でも
   * 「警告が出る」側の歯は通ってしまうため。
   */
  it("両方 prerelease なら next で、警告は出ない", () => {
    const r = distTagFor({ version: "0.2.0-beta.1", githubPrerelease: true });
    expect(r.npmTag).toBe("next");
    expect(r.warnings).toEqual([]);
  });

  /**
   * ⚠ ここは「安全側に倒す」判断そのものを固定している（ADR 0070）。
   * `latest` を誤って汚すと取り消せない。`next` へ入れ違えるのは
   * `npm dist-tag add` で直せる。**直せるほうの誤りを選ぶ。**
   */
  it("食い違ったときは latest ではなく next へ倒す", () => {
    expect(distTagFor({ version: "0.2.0-beta.1", githubPrerelease: false }).npmTag).toBe("next");
    expect(distTagFor({ version: "0.1.2", githubPrerelease: true }).npmTag).toBe("next");
  });
});

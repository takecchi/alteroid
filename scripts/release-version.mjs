/**
 * Release の tag から publish する版を決める純関数だけを集めたモジュール（ADR 0070）。
 *
 * **なぜ純関数として切り出すか**: `scripts/publish-dry-run.mjs` と同じ理由である
 * （ADR 0067）。判定を workflow の shell に直書きすると、**判定そのものを歯で測れない。**
 * ここに置けば、合成した入力に対して「壊した入力を落とし、直した入力を通す」ことを
 * 実際に確かめられる。
 *
 * ⚠ このモジュールは**ファイルを書かない。**書くのは `scripts/apply-release-version.mjs` である。
 */

/** semver の中核（prerelease と build metadata を含む）。公式の推奨正規表現を元にしている。 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Release の tag 名から版を取り出す。
 *
 * **なぜ「先頭の `v` を剥がす」だけにしないか**: `${TAG#v}` は `vfoo` を `foo` にし、
 * `version` は `foo` になる。それが `package.json` に書き込まれ、`pnpm pack` は
 * **文句を言わずに** `mnemora-core-foo.tgz` を作る。**publish の直前まで誰も気づかない。**
 * ⟹ ここで semver として妥当であることまで見る。
 *
 * @param {string | undefined | null} tagName Release の tag（`v0.1.2` を想定）
 * @returns {{ ok: true, version: string } | { ok: false, reason: string }}
 */
export function versionFromTag(tagName) {
  if (typeof tagName !== "string" || tagName.length === 0) {
    return { ok: false, reason: "tag が空です。" };
  }
  if (!tagName.startsWith("v")) {
    return {
      ok: false,
      reason: `tag は "v" で始まる必要があります（例: v0.1.2）。受け取ったもの: ${JSON.stringify(tagName)}`,
    };
  }
  const version = tagName.slice(1);
  if (!SEMVER.test(version)) {
    return {
      ok: false,
      reason: `tag から取り出した版が semver ではありません: ${JSON.stringify(version)}（tag: ${JSON.stringify(tagName)}）`,
    };
  }
  return { ok: true, version };
}

/**
 * publish する dist-tag を決める。
 *
 * **なぜ pre-release を分けるか**: GitHub は pre-release でも `published` を発火させる。
 * 分けないと **beta が `latest` になり、`npm i @mnemora/core` が beta を掴む。**
 *
 * **⚠ GitHub 側の「pre-release」チェックと、semver の prerelease 部（`-beta.1`）は別物である。**
 * 食い違ったとき（`v0.2.0-beta.1` を pre-release にチェックせず作った等）は、
 * **`latest` を汚さない側へ倒す**——どちらか一方でも prerelease なら `next` にする。
 * 取り違えて `latest` を汚すと取り消せないが、`next` に入れ違えるのは
 * `npm dist-tag add` で直せる。**直せるほうの誤りを選ぶ。**
 *
 * @param {{ version: string, githubPrerelease: boolean }} input
 * @returns {{ npmTag: "latest" | "next", warnings: string[] }}
 */
export function distTagFor({ version, githubPrerelease }) {
  const warnings = [];
  const semverPrerelease = version.includes("-");

  if (semverPrerelease && !githubPrerelease) {
    warnings.push(
      `版 ${version} は semver の prerelease ですが、Release は pre-release として作られていません。` +
        `latest を汚さないため next へ入れます。`,
    );
  }
  if (!semverPrerelease && githubPrerelease) {
    warnings.push(
      `Release は pre-release ですが、版 ${version} は semver の prerelease ではありません。next へ入れます。`,
    );
  }

  return { npmTag: semverPrerelease || githubPrerelease ? "next" : "latest", warnings };
}

#!/usr/bin/env node
/**
 * Release の tag の版を、publish 対象4パッケージの `package.json` へ**書き込む**段（ADR 0070）。
 *
 * **これがこの repo の版の決め方である。**`v0.1.2` の Release を作れば、この段が
 * 4つの `package.json` を `0.1.2` に書き換えてから `pnpm pack` が走る。
 * ⟹ **版上げのコミットは要らない。**
 *
 * **⚠ だから `packages/<pkg>/package.json` の `version` は、権威ある値ではない。**
 * git に入っている値は「最後に誰かが書いた値」であって、**npm 上の最新版とは限らない。**
 * 権威は **Release の tag** にある。確かめたいときは registry に訊くこと:
 *
 *     npm view @mnemora/core version
 *
 * **なぜ書き込む側と決める側を分けたか**: 判定（tag → 版・dist-tag）は
 * `./release-version.mjs` の純関数が持ち、歯はそちらを直接測る（ADR 0067 と同じ形）。
 * ここは「決まった値をファイルへ書く」ことと「書けたことを確かめる」ことだけをする。
 *
 * 使い方（workflow から）:
 *   RELEASE_TAG=v0.1.2 GITHUB_PRERELEASE=false node scripts/apply-release-version.mjs
 *
 * `$GITHUB_OUTPUT` へ `version=` と `npm_tag=` を書く。tag が semver でなければ EXIT=1。
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";
import { distTagFor, versionFromTag } from "./release-version.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const tag = process.env.RELEASE_TAG;
const githubPrerelease = process.env.GITHUB_PRERELEASE === "true";

const parsed = versionFromTag(tag);
if (!parsed.ok) {
  console.error(`::error::Release の tag から版を決められません: ${parsed.reason}`);
  process.exit(1);
}
const { version } = parsed;

const { npmTag, warnings } = distTagFor({ version, githubPrerelease });
for (const w of warnings) console.log(`::warning::${w}`);

/** 正規表現に埋め込む文字列を無害化する。 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 4つの `package.json` の **`version` の行だけ**を差し替える。
 *
 * **⚠ JSON として読んで `JSON.stringify` で書き戻してはならない。**実測した:
 * `JSON.stringify(manifest, null, 2)` は短い配列も必ず展開するが、prettier は
 * `"files": ["dist"]` を1行に畳む。⟹ 書き戻すと**このリポジトリの
 * `pnpm run format:check` が赤くなり、workflow はこの段の直後に門を通すので publish が止まる。**
 * （この食い違いは `scripts/__tests__/apply-release-version.test.mjs` の
 * 「書き換えた package.json が prettier の整形と一致する」歯が実際に捕まえた。）
 *
 * ⟹ **他の1文字も動かさない**形で `version` の行だけを差し替える。
 * 先頭2スペースに錨を打つのは、入れ子（`dependencies` の中など）の `"version"` を
 * 掴まないためである。書けたことは**読み直して JSON として検算する**。
 */
const changed = [];
for (const target of PUBLISH_TARGETS) {
  const path = join(repoRoot, target.dir, "package.json");
  const source = readFileSync(path, "utf8");
  const manifest = JSON.parse(source);

  if (manifest.name !== target.name) {
    console.error(
      `::error::${target.dir} の name が ${JSON.stringify(manifest.name)} で、期待した ${target.name} と違います。`,
    );
    process.exit(1);
  }

  const before = manifest.version;
  const pattern = new RegExp(`^(  "version": )"${escapeRegExp(before)}"`, "m");
  if (!pattern.test(source)) {
    console.error(
      `::error::${target.name} の package.json に、差し替えるべき version の行が見つかりません` +
        `（現在の値: ${JSON.stringify(before)}）。整形が変わった可能性があります。`,
    );
    process.exit(1);
  }
  writeFileSync(path, source.replace(pattern, `$1"${version}"`));
  changed.push({ name: target.name, before, after: version });
}

// 書けたことを、書いた値ではなく**読み直した値**で確かめる。
for (const target of PUBLISH_TARGETS) {
  const path = join(repoRoot, target.dir, "package.json");
  const actual = JSON.parse(readFileSync(path, "utf8")).version;
  if (actual !== version) {
    console.error(
      `::error::${target.name} の version を ${version} に書いたはずが、読み直すと ${JSON.stringify(actual)} でした。`,
    );
    process.exit(1);
  }
}

console.log(`版: ${version} / dist-tag: ${npmTag}`);
for (const c of changed) {
  console.log(
    `  ${c.name}: ${c.before} -> ${c.after}${c.before === c.after ? "（変化なし）" : ""}`,
  );
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nnpm_tag=${npmTag}\n`);
}

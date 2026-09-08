#!/usr/bin/env node
/**
 * publish 対象4パッケージを `pnpm pack` し、**publish 順序に並べた tarball の一覧**を出す段。
 *
 * **なぜ pack と publish を別の道具に分けるか（ADR 0066）**
 *
 * ADR 0060 は「publish の道具は pnpm に統一する」と決めた。理由は `npm pack` が
 * `workspace:*` を置換せず、素の consumer の install が `EUNSUPPORTEDPROTOCOL` で落ちるためである
 * （実測済み）。**その理由は今も有効だが、決定は狭める必要があった。**
 *
 * | 仕事 | 道具 | なぜ |
 * |---|---|---|
 * | 梱包（pack） | **pnpm** | `workspace:` を実版へ置換できるのは pnpm だけ（ADR 0060 の実測） |
 * | アップロード（publish） | **npm** | Trusted Publishing (OIDC) と provenance は npm CLI の側にある。`pnpm publish` に `--provenance` フラグは**無い** |
 *
 * `npm publish <tarball>` は**すでに解決済みの manifest を持つ tarball** を上げるだけなので、
 * `workspace:` を見ることが無い——つまり ADR 0060 が塞いだ穴は開かない。
 *
 * **この段は publish しない。**tarball を作って並べるところまでで、上げるのは
 * `.github/workflows/publish.yml` の仕事である。手元で中身を確かめたいときにも、
 * この段だけを単体で打てる。
 *
 * 使い方:
 *   node scripts/pack-publish-targets.mjs <出力先ディレクトリ> [--expect-version <版>]
 *
 * `--expect-version` を渡すと、4パッケージの版がそれと一致しない場合に落ちる
 * （workflow が tag `v0.1.0` と package.json の版のずれを掴むために使う）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const args = process.argv.slice(2);
const destArg = args.find((a) => !a.startsWith("--"));
const expectVersionIndex = args.indexOf("--expect-version");
const expectVersion = expectVersionIndex === -1 ? undefined : args[expectVersionIndex + 1];

if (!destArg) {
  console.error("出力先ディレクトリを渡してください: node scripts/pack-publish-targets.mjs <dir>");
  process.exit(1);
}
if (expectVersionIndex !== -1 && !expectVersion) {
  console.error("--expect-version に版を渡してください（例: --expect-version 0.1.0）。");
  process.exit(1);
}

const destDir = resolve(destArg);
mkdirSync(destDir, { recursive: true });

/** @type {string[]} */
const problems = [];
/** @type {{ name: string; version: string; tarball: string }[]} */
const packed = [];

for (const target of PUBLISH_TARGETS) {
  const pkgDir = join(repoRoot, target.dir);
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

  if (manifest.name !== target.name) {
    problems.push(
      `${target.dir} の name が ${JSON.stringify(manifest.name)} で、期待した ${target.name} と違います。`,
    );
    continue;
  }
  if (expectVersion && manifest.version !== expectVersion) {
    problems.push(
      `${target.name} の version が ${JSON.stringify(manifest.version)} で、期待した ${expectVersion} と違います。`,
    );
    continue;
  }

  // pack 先をパッケージごとに分けるのは、生成された tarball が1つだけであることを
  // 名前に依らず確かめられるようにするため（`check-publish-pack.mjs` と同じ理由）。
  const perPackageDir = join(destDir, target.name.replace("@", "").replace("/", "-"));
  mkdirSync(perPackageDir, { recursive: true });

  console.log(`[${target.name}] pnpm pack ...`);
  const result = spawnSync("pnpm", ["pack", "--pack-destination", perPackageDir], {
    cwd: pkgDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    problems.push(`${target.name} の pnpm pack が exit ${result.status} で失敗しました。`);
    continue;
  }

  const tarballs = readdirSync(perPackageDir).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    problems.push(
      `${target.name} の pack 先に tarball が ${tarballs.length} 個ありました（1個のはず）: ${tarballs.join(", ")}`,
    );
    continue;
  }

  packed.push({
    name: target.name,
    version: manifest.version,
    tarball: join(perPackageDir, tarballs[0]),
  });
}

if (problems.length > 0) {
  console.error("");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("");
  process.exit(1);
}

// publish 順序を一覧ファイルに書き出す。workflow はこの順に `npm publish` を打つ。
const listPath = join(destDir, "publish-order.txt");
writeFileSync(listPath, packed.map((p) => p.tarball).join("\n") + "\n");

console.log("");
console.log("publish 順（依存の向き。この順に npm publish を打つこと）:");
for (const [i, p] of packed.entries()) {
  console.log(`  ${i + 1}. ${p.name}@${p.version}  ${p.tarball}`);
}
console.log("");
console.log(`一覧: ${listPath}`);

#!/usr/bin/env node
/**
 * publish 対象4パッケージ（`@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
 * `@mnemora/openai`）を実際に `pnpm pack` し、**tarball の中身**を検査する門。
 *
 * **なぜ tarball の中身を見るか（作業ツリーの package.json を見るだけでは足りない理由）**
 *
 * 実測して確認した2つの落とし穴:
 *
 * 1. `dist/` が無い状態で `pnpm pack` を打っても、**exit code 0・エラー出力なし**で
 *    「`package/package.json` 1ファイルだけ」の tarball が出来る。`files: ["dist"]` の
 *    指す先が空でも、pack は誰も文句を言わない。`prepack` を足したことでこの穴は塞いだが、
 *    「塞いだこと」自体を作業ツリーの package.json を読むだけでは確認できない
 *    （`prepack` が実際にビルドを再生成するかは、走らせてみないと分からない）。
 * 2. `workspace:*` は `npm pack` ではそのまま tarball に残り、素の consumer が
 *    `npm install` すると `npm error code EUNSUPPORTEDPROTOCOL` で落ちる。`pnpm pack` は
 *    実版へ置換して出す。**だからこの repo の publish の道具は pnpm に統一する**——
 *    この門も `npm pack` ではなく `pnpm pack` だけを使う。
 *
 * **対象は固定リストである（動的に発見しない）。** `scripts/run-db-tests.mjs` は
 * `test:db` script の有無で対象を発見しているが、ここでは同じ手が使えない——
 * publish 対象と非対象（ルートの `mnemora` / `@mnemora/example-chat`）を分ける
 * 機械的な目印が今のところ無い（両方とも `private: true` のまま。publish 開始時に
 * 対象4つだけ `private` を外す判断は別途あるが、この時点ではまだ無い）。
 * 対象は上位で決定済みなので固定リストで持つ。**新しい publish 対象パッケージが
 * 増えたら、このリストにも手で足す必要がある**——見落としを機械的には検知できない。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findWorkspaceProtocolViolations,
  findMissingEntryPoints,
  findOrphanedSourceMaps,
} from "./publish-pack-checks.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const BANNER = "─".repeat(72);

/** publish 対象4パッケージ。ディレクトリはリポジトリ直下からの相対パス。 */
const PUBLISH_TARGETS = [
  { name: "@mnemora/core", dir: "packages/core" },
  { name: "@mnemora/testkit", dir: "packages/testkit" },
  { name: "@mnemora/postgres", dir: "packages/postgres" },
  { name: "@mnemora/openai", dir: "packages/openai" },
];

/**
 * 判定関数（`findWorkspaceProtocolViolations` / `findMissingEntryPoints` /
 * `findOrphanedSourceMaps`）の本体は `./publish-pack-checks.mjs` にある。
 * ここに実装を持たないのは、`scripts/__tests__/check-publish-pack.test.mjs` が
 * `pnpm pack` を一切走らせずに合成フィクスチャへ直接それらを呼べるようにするため
 * （`publish-pack-checks.mjs` 冒頭のコメント参照）。
 */

/** `pnpm pack` を実行し、生成された tarball のパスを返す。 */
function packOne(target, destDir) {
  const pkgDir = join(repoRoot, target.dir);
  const result = spawnSync("pnpm", ["pack", "--pack-destination", destDir], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `pnpm pack が失敗しました（${target.name}, exit ${result.status}）:\n${result.stderr ?? result.stdout ?? ""}`,
    );
  }
  const tarballs = readdirSync(destDir).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `${target.name} の pack 先に tarball が ${tarballs.length} 個ありました（1個のはず）: ${tarballs.join(", ")}`,
    );
  }
  return join(destDir, tarballs[0]);
}

/** tarball を展開し、`package/` ディレクトリの絶対パスを返す。 */
function extractTarball(tarballPath, destDir) {
  const result = spawnSync("tar", ["xzf", tarballPath, "-C", destDir], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar xzf に失敗しました（${tarballPath}）:\n${result.stderr ?? ""}`);
  }
  return join(destDir, "package");
}

console.log(
  [
    "",
    BANNER,
    "publish 梱包の門: 対象4パッケージを pnpm pack し、tarball の中身を検査します",
    "",
    "  対象:",
    ...PUBLISH_TARGETS.map((t) => `    - ${t.name} (${t.dir})`),
    "",
    "  検査項目:",
    "    1. workspace: プロトコルが依存に残っていないこと",
    "    2. version が 0.0.0 でなく、4パッケージとも同じ版であること",
    "    3. main / types / bin の指すファイルが tarball 内に実在すること",
    "    4. README.md が tarball に入っていること",
    '    5. publishConfig.access が "public" であること',
    "    6. 宙に浮いた source map（*.map の sources が tarball 内に無い）が無いこと",
    BANNER,
    "",
  ].join("\n"),
);

/** @type {string[]} */
const violations = [];
/** @type {{ name: string; version: string }[]} */
const versions = [];
const cleanupDirs = [];

try {
  for (const target of PUBLISH_TARGETS) {
    const workDir = mkdtempSync(join(tmpdir(), "mnemora-pack-check-"));
    cleanupDirs.push(workDir);
    const packDestDir = join(workDir, "pack");
    const extractDestDir = join(workDir, "extract");
    mkdirSync(packDestDir, { recursive: true });
    mkdirSync(extractDestDir, { recursive: true });

    console.log(`  [${target.name}] pnpm pack ...`);

    let tarballPath;
    try {
      tarballPath = packOne(target, packDestDir);
    } catch (error) {
      violations.push(`[${target.name}] ${error.message}`);
      continue;
    }

    const packageDir = extractTarball(tarballPath, extractDestDir);
    const manifestPath = join(packageDir, "package.json");
    /** @type {Record<string, unknown>} */
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      violations.push(
        `[${target.name}] tarball 内の package/package.json が読めません: ${error.message}`,
      );
      continue;
    }

    // 1. workspace: プロトコル
    const workspaceViolations = findWorkspaceProtocolViolations(manifest);
    for (const v of workspaceViolations) {
      violations.push(`[${target.name}] workspace: プロトコルが残っています: ${v}`);
    }

    // 2. version
    if (manifest.version === "0.0.0" || !manifest.version) {
      violations.push(`[${target.name}] version が未設定か 0.0.0 のままです: ${manifest.version}`);
    } else {
      versions.push({ name: target.name, version: manifest.version });
    }

    // 3. main / types / bin の実在
    const missingEntryPoints = findMissingEntryPoints(manifest, packageDir);
    for (const m of missingEntryPoints) {
      violations.push(`[${target.name}] tarball 内に実在しないエントリポイント: ${m}`);
    }

    // 4. README.md
    try {
      statSync(join(packageDir, "README.md"));
    } catch {
      violations.push(`[${target.name}] README.md が tarball に入っていません`);
    }

    // 5. publishConfig.access
    if (manifest.publishConfig?.access !== "public") {
      violations.push(
        `[${target.name}] publishConfig.access が "public" ではありません: ${JSON.stringify(manifest.publishConfig)}`,
      );
    }

    // 6. 宙に浮いた source map
    const orphanedMaps = findOrphanedSourceMaps(packageDir);
    for (const o of orphanedMaps) {
      violations.push(`[${target.name}] 宙に浮いた source map: ${o}`);
    }
  }

  // 4パッケージとも同じ版であること（version 自体が有効だったものだけを比較する）
  const distinctVersions = new Set(versions.map((v) => v.version));
  if (versions.length === PUBLISH_TARGETS.length && distinctVersions.size > 1) {
    violations.push(
      `version が4パッケージで揃っていません: ${versions.map((v) => `${v.name}@${v.version}`).join(", ")}`,
    );
  }
} finally {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (violations.length > 0) {
  console.log(
    [
      "",
      BANNER,
      `✗ 違反が ${violations.length} 件見つかりました`,
      "",
      ...violations.map((v) => `  - ${v}`),
      "",
      BANNER,
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(["", BANNER, "✔ publish 梱包の門を通りました。", BANNER, ""].join("\n"));

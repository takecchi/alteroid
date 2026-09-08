/**
 * `scripts/check-publish-pack.mjs` が使う純粋な判定関数だけを集めたモジュール。
 *
 * **なぜ分けたか**: `check-publish-pack.mjs` は import された瞬間に本物の `pnpm pack` を
 * 4パッケージぶん走らせる（トップレベルの実行部にガードが無い）。判定関数だけをここへ
 * 切り出せば、`scripts/__tests__/check-publish-pack.test.mjs` は合成フィクスチャに対して
 * `pnpm pack` を一切走らせずに、各関数が実際に噛むか（違反を作ったら検出し、直したら
 * 検出しないか）を直接測れる。
 *
 * ここに置く関数は副作用（`console.log` / `process.exit` / 子プロセス起動）を持たない。
 * 持たせたくなったら、それは `check-publish-pack.mjs` 側に置くべきものである。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** `dependencies` 等のどの値も `workspace:` プロトコルで始まっていないか調べる。 */
export function findWorkspaceProtocolViolations(manifest) {
  const violations = [];
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = manifest[field];
    if (!deps) continue;
    for (const [depName, range] of Object.entries(deps)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        violations.push(`${field}.${depName} = "${range}"`);
      }
    }
  }
  return violations;
}

/** `main` / `types` / `bin` が指すファイルのうち、tarball 内に実在しないものを集める。 */
export function findMissingEntryPoints(manifest, packageDir) {
  const missing = [];
  const check = (label, relPath) => {
    if (!relPath) return;
    const absPath = resolve(packageDir, relPath);
    try {
      statSync(absPath);
    } catch {
      missing.push(`${label} -> ${relPath}`);
    }
  };
  check("main", manifest.main);
  check("types", manifest.types);
  if (manifest.bin) {
    if (typeof manifest.bin === "string") {
      check("bin", manifest.bin);
    } else {
      for (const [binName, binPath] of Object.entries(manifest.bin)) {
        check(`bin.${binName}`, binPath);
      }
    }
  }
  return missing;
}

/** `dir` 以下を再帰的に歩き、`predicate(fullPath)` が true のファイルパスを集める。 */
export function findFiles(dir, predicate, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findFiles(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `license` が `MIT` であること、`LICENSE` ファイルが tarball 内（に相当するディレクトリ）に
 * 実在することを調べる（ADR 0061）。
 *
 * **なぜ「`UNLICENSED` でないこと」ではなく「`MIT` と等しいこと」を見るか**: 前者は
 * `Apache-2.0` のような隣の値もそのまま通してしまう弱い歯になる。オーナーは MIT を
 * 名指しで選んでいる（ADR 0061 逐語）——ここで検査したいのは「publish 可能な何らかの値」
 * ではなく「選んだ値そのもの」である。
 *
 * **なぜ作業ツリーの `package.json` ではなく `manifest`（呼び出し側が tarball を展開して
 * 読んだもの）を受け取るか**: `license` フィールドが作業ツリーで `MIT` でも、`files` の
 * 絞り込みや `.npmignore` 相当の設定次第では、使う人が実際に受け取る tarball の中身は
 * 別物でありうる。**このモジュールの他の関数（`findMissingEntryPoints` 等）と同じく、
 * 呼び出し側が「pack して展開した実体」を渡す前提に揃えている。**
 */
export function findLicenseViolations(manifest, packageDir) {
  const violations = [];
  if (manifest.license !== "MIT") {
    violations.push(`license が "MIT" ではありません: ${JSON.stringify(manifest.license)}`);
  }
  try {
    statSync(join(packageDir, "LICENSE"));
  } catch {
    violations.push("LICENSE ファイルが tarball に入っていません");
  }
  return violations;
}

/**
 * tarball 内（に相当するディレクトリ）の `*.map` のうち、`sources` がそのディレクトリ内に
 * 実在しない相対パスを指しているものを集める（「宙に浮いた source map」）。
 *
 * **これは publish 前の現物で実際に起きていた形そのものである**: 修正前の
 * `packages/core` の `dist/index.d.ts.map` は `sources: ["../src/index.ts"]` を持っていたが、
 * `files: ["dist"]` は `src/` を tarball に含めないため、その実体は tarball の中に無かった
 * （実測して確認した）。`tsconfig.build.json` に `declarationMap`/`sourceMap: false` を
 * 足して以降、ビルドはそもそも `.map` を出さなくなったので、この関数が現物に対して
 * 何かを検出することは今は無いはずである。だからこそ、この関数が「壊した入力に対しては
 * 実際に検出する」ことを合成フィクスチャで別途測る必要がある
 * （`scripts/__tests__/check-publish-pack.test.mjs` 参照）。
 */
export function findOrphanedSourceMaps(packageDir) {
  const mapFiles = findFiles(packageDir, (path) => path.endsWith(".map"));
  const orphans = [];
  for (const mapFile of mapFiles) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(mapFile, "utf8"));
    } catch (error) {
      orphans.push(`${relative(packageDir, mapFile)}: JSON として読めない (${error.message})`);
      continue;
    }
    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    for (const source of sources) {
      const resolved = resolve(dirname(mapFile), source);
      try {
        statSync(resolved);
      } catch {
        orphans.push(
          `${relative(packageDir, mapFile)}: sources に "${source}" とあるが tarball 内に無い`,
        );
      }
    }
  }
  return orphans;
}

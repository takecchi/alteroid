import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/check-cjs-transpile-parse.mjs`（CJS 構文解析の門）の歯。
 *
 * ⚠ この歯のファイル自身、このコメントも含めて `import.meta` という文字列を何度も含む。
 * それでも門と混ざらない——門が見るのは `packages/<name>/dist`（このファイルの
 * `CJS_PARSE_CHECK_PACKAGES_ROOT` で差し替えたフィクスチャの `<root>/<name>/dist`）だけであり、
 * `scripts/__tests__/` はそもそも対象に入らない。この歯自身が壊れずに存在していることが、
 * その境界が実際に効いていることの一番手っ取り早い証拠でもある。
 *
 * ⚠ フィクスチャは常に一時ディレクトリ（`mkdtempSync` + `tmpdir()`）に作り、
 * `afterEach` で必ず消す。作業ツリーの `packages/<name>/dist` には一切触れない
 * （CI の `build` ジョブでは、この歯を走らせる「Test」段は「Build」段より**前**にあり、
 * 実物の dist はまだ存在しない可能性がある——だからこの歯は実物の dist を読みに行く
 * テストを持たない。門本体を実物に対して走らせる確認は、
 * `.github/workflows/ci.yml` の `build` ジョブが `Build` の直後に行う）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const gate = fileURLToPath(new URL("../check-cjs-transpile-parse.mjs", import.meta.url));

// `./publish-targets.mjs` の `PUBLISH_TARGETS` と同じ5パッケージ名（ディレクトリ名）。
// 門はこのリストを `./publish-targets.mjs` から読むが、歯はフィクスチャの形を
// 手で組み立てる必要があるので、`scripts/__tests__/check-publish-pack.test.mjs` に
// ならって名前だけをここにも直書きする。
const PACKAGE_DIRS = ["core", "testkit", "openai", "postgres", "anthropic"];

/** @type {string | undefined} */
let fixtureRoot;

afterEach(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  }
});

/** 一時ディレクトリの下に `<root>/packages/<name>/dist` という、門が読む形を作る。 */
function newFixtureRoot() {
  const base = mkdtempSync(join(tmpdir(), "cjs-parse-check-"));
  const packagesDir = join(base, "packages");
  mkdirSync(packagesDir, { recursive: true });
  return packagesDir;
}

/** 5パッケージすべてに、CommonJS として問題なく解析できる `dist/index.js` を置く。 */
function writeCleanDistForAll(packagesDir) {
  for (const name of PACKAGE_DIRS) {
    const distDir = join(packagesDir, name, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.js"), "export const ok = true;\n");
  }
}

/** 指定した1パッケージだけ `dist/index.js` の中身を差し替える（他は clean のまま）。 */
function writeDistFile(packagesDir, name, contents) {
  const distDir = join(packagesDir, name, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.js"), contents);
}

function runGate(packagesDir) {
  const result = spawnSync(process.execPath, [gate], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CJS_PARSE_CHECK_PACKAGES_ROOT: packagesDir },
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("scripts/check-cjs-transpile-parse.mjs（CJS 構文解析の門）", () => {
  it("import.meta を実際に使う配布物を与えると赤くなる（Issue #110 に言及する）", () => {
    fixtureRoot = newFixtureRoot();
    writeCleanDistForAll(fixtureRoot);
    // anthropic の index.js だけ、実際に import.meta を使う形へ差し替える。
    writeDistFile(
      fixtureRoot,
      "anthropic",
      ["export const selfUrl = new URL(import.meta.url);", ""].join("\n"),
    );

    const { status, output } = runGate(fixtureRoot);

    expect(status, `期待した非0にならなかった。出力:\n${output}`).not.toBe(0);
    expect(output).toContain("CommonJS として解析できません");
    expect(output).toContain("Cannot use 'import.meta' outside a module");
    expect(output).toContain("Issue #110");
  });

  it("きれいな配布物だけを与えると緑になる", () => {
    fixtureRoot = newFixtureRoot();
    writeCleanDistForAll(fixtureRoot);

    const { status, output } = runGate(fixtureRoot);

    expect(status, `期待した EXIT=0 にならなかった。出力:\n${output}`).toBe(0);
    expect(output).toContain("個の配布物が CommonJS として解析できました");
    // 5パッケージ×1ファイルずつを検査したこと（数を出す、を固定する）。
    expect(output).toContain("✔ 5 個の配布物");
  });

  /**
   * 🔴 「赤くなってはいけない変異」の歯。
   *
   * 実際に `packages/postgres/dist/migrations-dir.cjs` は、なぜ `import.meta` を
   * 避けたかを説明する doc コメントの中に `import.meta` という文字列を複数回含む
   * （`packages/postgres/src/migrations-dir.cts` の冒頭コメントがビルド後もほぼ
   * そのまま残る）。`grep "import.meta"` で測る門なら、ここで実害の無いコメントに対して
   * 誤って赤くなる。この歯はそれが起きないこと——門が構文解析（`vm.compileFunction`）で
   * 測っており、文字列の有無では測っていないこと——を固定する。
   */
  it("import.meta という文字列がコメントの中だけに在る配布物では緑のままである", () => {
    fixtureRoot = newFixtureRoot();
    writeCleanDistForAll(fixtureRoot);
    writeDistFile(
      fixtureRoot,
      "postgres",
      [
        "/**",
        " * なぜ import.meta を避けたか。",
        " * import.meta は CommonJS として解析されると構文解析の時点で落ちる。",
        " * import.meta.url は使わない。import.meta.resolve も使わない。",
        " */",
        "export const DEFAULT_MIGRATIONS_DIR = __dirname;",
        "",
      ].join("\n"),
    );

    const { status, output } = runGate(fixtureRoot);

    expect(status, `期待した EXIT=0 にならなかった。出力:\n${output}`).toBe(0);
    expect(output).toContain("個の配布物が CommonJS として解析できました");
    expect(output).not.toContain("CommonJS として解析できません");
  });

  it("dist が無いパッケージが在ると赤くなる（先に build を打てと言う）", () => {
    fixtureRoot = newFixtureRoot();
    writeCleanDistForAll(fixtureRoot);
    // anthropic の dist を作らない状態にする、を再現するため作り直す。
    rmSync(join(fixtureRoot, "anthropic"), { recursive: true, force: true });

    const { status, output } = runGate(fixtureRoot);

    expect(status, `期待した非0にならなかった。出力:\n${output}`).not.toBe(0);
    expect(output).toContain("dist が見つかりません");
    expect(output).toContain("@mnemora/anthropic");
    expect(output).toContain("pnpm run build");
  });

  it("対象ファイルが0件だと赤くなる（空振りで緑にしない）", () => {
    fixtureRoot = newFixtureRoot();
    // 全パッケージに dist は作るが、.js / .cjs / .mjs は1つも置かない
    // （.d.ts だけがある = ビルドはされたが対象拡張子が無い状態）。
    for (const name of PACKAGE_DIRS) {
      const distDir = join(fixtureRoot, name, "dist");
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, "index.d.ts"), "export {};\n");
    }

    const { status, output } = runGate(fixtureRoot);

    expect(status, `期待した非0にならなかった。出力:\n${output}`).not.toBe(0);
    expect(output).toContain("検査対象のファイルが1件も見つかりませんでした");
  });
});

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * 「vitest の unhandled error 1件」が、テストを全部通したまま門を緑にしてしまう
 * 抜け道を塞ぐ歯（ADR 0020）。
 *
 * `packages/postgres/src/__tests__/migrate-concurrency.test.ts` /
 * `vector-space-concurrency.test.ts` の間欠障害そのものは `dropTempDatabase`
 * （`temp-database.ts`）が根で直したが、それとは別に、**この種の失敗を握り潰す設定
 * （`dangerouslyIgnoreUnhandledErrors`）を将来どこかへ足せば、同じ穴が形を変えて
 * 戻ってくる。**それを塞がずに黙らせるのがオーナーが名指しで禁じた直し方である。
 *
 * 2本の歯:
 * - **静的**: repo 内の vitest 設定・package.json の scripts のどこにも
 *   `dangerouslyIgnoreUnhandledErrors` が無いことを検査する。
 * - **動的**: 「テストは全部通るが非同期の unhandled error が1件出る」だけの
 *   使い捨てのフィクスチャを作り、本物の vitest（このリポジトリの node_modules の
 *   ものと同じバージョン）を子プロセスで実際に走らせて、**exit code が非0になり、
 *   出力に unhandled error が出ること**を実測する。これが静的な歯に意味がある
 *   ことの根拠になる（`dangerouslyIgnoreUnhandledErrors: true` を足すと exit code が
 *   0 に変わってしまうことも、実装時に手元で確認済み——テストは全部通ったという
 *   出力は変わらないまま、エラーだけが握り潰される）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "coverage", ".git", ".tmp"]);

/** `repoRoot` 以下を再帰的に歩き、`predicate(fullPath)` が true のファイルパスを集める。 */
function findFiles(dir, predicate, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      findFiles(join(dir, entry.name), predicate, out);
    } else if (predicate(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

describe("dangerouslyIgnoreUnhandledErrors を repo のどこにも設定していない（静的）", () => {
  it("vitest.config.mts のどれも dangerouslyIgnoreUnhandledErrors を設定していない", () => {
    const configFiles = findFiles(repoRoot, (name) => name === "vitest.config.mts");
    // 少なくとも root + vitest.config.mts を持つ5つ（openai / anthropic / postgres /
    // testkit / examples/chat）は在るはず（数え落とし自体を検知する）。
    expect(configFiles.length).toBeGreaterThanOrEqual(6);

    const offenders = configFiles.filter((file) =>
      readFileSync(file, "utf8").includes("dangerouslyIgnoreUnhandledErrors"),
    );
    expect(offenders).toEqual([]);
  });

  it("package.json の scripts のどれも dangerouslyIgnoreUnhandledErrors を渡していない", () => {
    const manifests = findFiles(repoRoot, (name) => name === "package.json");
    expect(manifests.length).toBeGreaterThan(0);

    const offenders = [];
    for (const file of manifests) {
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      for (const [scriptName, command] of Object.entries(manifest.scripts ?? {})) {
        if (String(command).includes("dangerouslyIgnoreUnhandledErrors")) {
          offenders.push(`${file}#scripts.${scriptName}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("vitest は『全部通ったが unhandled error が1件』を緑にしない（動的・実測）", () => {
  /** @type {string | undefined} */
  let fixtureDir;

  afterEach(() => {
    if (fixtureDir) {
      rmSync(fixtureDir, { recursive: true, force: true });
      fixtureDir = undefined;
    }
  });

  it("テストが全部 passed でも、unhandled error が在れば exit code が非0になる", () => {
    // repo 直下の .gitignore 済みディレクトリ（.tmp/）の下に作る。root の vitest の
    // include は `scripts/**/*.test.mjs` なのでこのフィクスチャはそこに当たらない
    // （`.tmp/` は SKIP_DIR_NAMES にも入れてあり、上の静的な歯からも除外される）。
    const tmpRoot = join(repoRoot, ".tmp");
    mkdirSync(tmpRoot, { recursive: true });
    fixtureDir = mkdtempSync(join(tmpRoot, "no-unhandled-errors-"));

    writeFileSync(
      join(fixtureDir, "vitest.config.mts"),
      [
        'import { defineConfig } from "vitest/config";',
        "",
        "export default defineConfig({",
        '  test: { include: ["*.fixture.test.mjs"] },',
        "});",
        "",
      ].join("\n"),
    );

    // migrate-concurrency.test.ts で実際に起きた形（`await pool.end()` が resolve した
    // 直後にもサーバー側の接続がまだ生きていて、非同期に 'error' が発火する）を
    // 忠実に再現する必要は無い——「アサーションは全部通るのに、非同期に発火する
    // 未処理のエラーが1件だけ在る」という*形*だけを、DB 無しで再現すれば足りる。
    writeFileSync(
      join(fixtureDir, "unhandled.fixture.test.mjs"),
      [
        'import { it, expect } from "vitest";',
        'import { EventEmitter } from "node:events";',
        "",
        'it("passes but leaves an unhandled error behind", () => {',
        "  expect(1).toBe(1);",
        "  setImmediate(() => {",
        "    const ee = new EventEmitter();",
        '    ee.emit("error", new Error("synthetic unhandled error for gate check"));',
        "  });",
        "});",
        "",
      ].join("\n"),
    );

    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--root",
        fixtureDir,
        "--config",
        join(fixtureDir, "vitest.config.mts"),
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        // GitHub Actions のランナーは（ログビューアが ANSI を解釈できるため）子プロセスの
        // 標準出力に色を強制することがある。実測して確認した: `FORCE_COLOR=1` の下で
        // vitest を走らせると、reporter が "Test Files" と "1 passed (1)" の間に
        // エスケープシーケンスを挟み込み、この歯の `toContain` の素朴な文字列一致が
        // 見た目には出力に含まれているのに一致しなくなる（CI で実際に踏んだ）。
        // `NO_COLOR=1` はそれに優先して色を止めることを実測で確認済みなので、ここで
        // 明示的に指定し、実行環境の色設定に結果が左右されないようにする。
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    // NO_COLOR/FORCE_COLOR はランナーが尊重してくれることへの依存でしかない
    // （実測: 尊重されない/上書きされる環境がありうる）。より強い保証として、
    // 一致させる前に ANSI エスケープシーケンスそのものを剥がす。
    // eslint-disable-next-line no-control-regex -- ANSI エスケープの除去に \x1b を使う。
    const plain = output.replace(/\x1b\[[0-9;]*m/g, "");

    // 芯: テストのアサーションは全部通っているのに、門は緑にならない。
    //
    // 空白の個数をリテラルで固定しない（`\s+` にする）: vitest のバージョンが
    // reporter の桁揃え方法を変えるだけでこの歯が赤くなるのは脆さであり、
    // この歯が守りたい区別（全部 passed でも unhandled error が在れば赤になること）
    // とは無関係。**ただし件数の数字（`1`）は固定したままにする**——ここを
    // `\d+` のように緩めると、「1 passed」と「2 passed」を区別できなくなり、
    // 歯の芯（“全部 passed でも”）そのものが測れなくなる。
    expect(plain).toMatch(/Test Files\s+1 passed\s+\(1\)/);
    expect(plain).toMatch(/Vitest caught\s+1\s+unhandled error/);
    expect(result.status).not.toBe(0);
  }, 60_000);
});

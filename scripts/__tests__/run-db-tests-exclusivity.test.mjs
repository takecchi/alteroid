import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/run-db-tests.mjs` の芯: **一度に1パッケージしか `test:db` を起動しない**こと
 * を、振る舞いとして測る歯。
 *
 * **静的な歯（コードの文字列を grep する類）では測らない。** 測りたいのは
 * 「実際に2つの区間が重ならないか」であって、「ループを書いたかどうか」ではない。
 *
 * 手口: 一時的な擬似ワークスペースを作る。`test:db` を持つパッケージを2つ置くが、
 * **互いに依存させない**——依存させると、いま直そうとしている「依存グラフのたまたまの
 * 直列」を歯の中で再現するだけになり、この段自身が持つ排他を何も測れなくなる
 * （run-db-tests.mjs 冒頭のコメント参照）。それぞれの `test:db` は開始・終了時刻を
 * 1つのログファイルへ書いて数百msだけ眠る、それだけの純粋関数。
 *
 * `packages/postgres` / `examples/chat` の歯（`run-db-tests.test.mjs`）と同じ流儀で
 * **本物の `scripts/run-db-tests.mjs` を子プロセスとして起動する**（擬似の実行器に
 * 差し替えない）。ただし本物のファイルをそのまま `require`/`import` すると、
 * そのスクリプトは自分の`import.meta.url`（＝自分が置かれた場所）からリポジトリの
 * 場所を決めるため、擬似ワークスペースの中で動かすには**同じ内容のファイルを
 * 擬似ワークスペースの `scripts/run-db-tests.mjs` としてコピーする**必要がある
 * （シンボリックリンクは Node が実体パスへ解決してしまうため使えない。実測して確認した）。
 * 中身は実行の都度 `readFileSync` で読み直すので、スクリプトを直したのに歯だけ古い
 * コピーを検査する、ということは起きない。
 *
 * `DATABASE_URL` は本物の DB を要求しない——このスクリプトは `DATABASE_URL` の
 * 有無だけを見て `test:db` を呼び出すかどうかを決めており、接続文字列の中身までは
 * 検査しない。中身を検査するのは各パッケージの `test:db` 自身（今回の擬似ワークスペースの
 * `test:db` は DB に一切触れない）。
 */

const REAL_SCRIPT_PATH = fileURLToPath(new URL("../run-db-tests.mjs", import.meta.url));

/**
 * `sourcePath` と、それが相対 import している同ディレクトリの `.mjs` を、
 * 辿れる限り `destDir` へ運ぶ。
 *
 * **なぜ「辿る」のか**: コピーする名前を手で並べると、依存が増えたときに
 * 黙って漏れる。漏れたときこの歯は `ERR_MODULE_NOT_FOUND` で赤くなるが、
 * それは**この歯が測るはずの「排他」とは無関係な赤**であり、
 * 読んだ人を間違った場所へ連れて行く。
 */
function copyScriptWithLocalDeps(sourcePath, destDir, copied = new Set()) {
  const name = basename(sourcePath);
  if (copied.has(name)) return;
  copied.add(name);
  copyFileSync(sourcePath, join(destDir, name));
  const source = readFileSync(sourcePath, "utf8");
  for (const matched of source.matchAll(/from\s+"\.\/([^"]+\.mjs)"/g)) {
    copyScriptWithLocalDeps(join(dirname(sourcePath), matched[1]), destDir, copied);
  }
}

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 擬似ワークスペースを作る。`sleepMs` はそれぞれのパッケージの `test:db` が
 * 眠る時間（重なりを検出しやすくするため、実行時間そのものを長めに取る）。
 */
function makeWorkspace(sleepMs) {
  const dir = mkdtempSync(join(tmpdir(), "run-db-tests-exclusivity-"));
  tmpDirs.push(dir);

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "exclusivity-probe-root", private: true }),
  );
  writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "pkg-a"\n  - "pkg-b"\n');

  for (const pkg of ["pkg-a", "pkg-b"]) {
    mkdirSync(join(dir, pkg), { recursive: true });
    // 互いに依存しない(!) ── どちらの package.json の dependencies にも
    // もう一方の名前を書かない。書いた瞬間、run-db-tests.mjs の位相ソートが
    // それを直列にする理由を作ってしまい、この歯が測りたい「排他がこの段自身の
    // コードに載っているか」を測れなくなる。
    writeFileSync(
      join(dir, pkg, "package.json"),
      JSON.stringify({
        name: pkg,
        version: "0.0.0",
        private: true,
        scripts: { "test:db": "node ./run.mjs" },
      }),
    );
    writeFileSync(
      join(dir, pkg, "run.mjs"),
      [
        'import fs from "node:fs";',
        "const log = process.env.TIMELINE_LOG;",
        `const name = ${JSON.stringify(pkg)};`,
        "fs.appendFileSync(log, `${name} start ${Date.now()}\\n`);",
        `await new Promise((r) => setTimeout(r, ${sleepMs}));`,
        "fs.appendFileSync(log, `${name} end ${Date.now()}\\n`);",
      ].join("\n"),
    );
  }

  mkdirSync(join(dir, "scripts"), { recursive: true });
  // シンボリックリンクではなくコピー(理由はファイル冒頭のコメント参照)。
  // 実行の都度コピーするので、本物のスクリプトの「今の中身」を検査する。
  //
  // **⚠ 1ファイルだけをコピーしない。** 本物のスクリプトが同じディレクトリの別の
  // `.mjs` を import するようになった瞬間、擬似ワークスペース側では
  // `ERR_MODULE_NOT_FOUND` になり、この歯は「排他が壊れた」のではなく
  // 「モジュールが無い」で赤くなる——**実際に一度そうなった**
  // (`scripts/db-server-description.mjs` を足したとき)。
  // ⟹ import を辿って、必要なものを一緒に運ぶ。次に依存が増えても漏れない。
  copyScriptWithLocalDeps(REAL_SCRIPT_PATH, join(dir, "scripts"));

  return dir;
}

/** @returns {{ name: string; start: number; end: number }[]} */
function parseTimeline(logPath) {
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  /** @type {Record<string, { start?: number; end?: number }>} */
  const byName = {};
  for (const line of lines) {
    const [name, kind, ts] = line.split(" ");
    byName[name] ??= {};
    byName[name][kind] = Number(ts);
  }
  return Object.entries(byName).map(([name, { start, end }]) => ({ name, start, end }));
}

function intervalsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

describe("scripts/run-db-tests.mjs の排他（振る舞いの歯）", () => {
  it("互いに依存しない2パッケージの test:db を、区間が重ならないよう順に実行する", () => {
    const dir = makeWorkspace(400);
    const timelineLog = join(dir, "timeline.log");
    writeFileSync(timelineLog, "");

    const result = spawnSync(process.execPath, [join(dir, "scripts", "run-db-tests.mjs")], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://dummy:dummy@localhost:1/dummy",
        TIMELINE_LOG: timelineLog,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(output, output).toContain("DB テストを実行します");
    expect(output, output).toContain("✔ DB テストも実行し、通りました。");
    expect(result.status, output).toBe(0);

    const timeline = parseTimeline(timelineLog);
    expect(timeline).toHaveLength(2);
    const [a, b] = timeline;

    expect(
      intervalsOverlap(a, b),
      `2つの区間が重なっている(並行に走った): ${JSON.stringify(timeline)}`,
    ).toBe(false);
  });
});

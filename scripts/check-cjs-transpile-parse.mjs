#!/usr/bin/env node
/**
 * publish 対象パッケージ（`./publish-targets.mjs` の `PUBLISH_TARGETS`。現在は
 * `@mnemora/core` / `@mnemora/testkit` / `@mnemora/openai` / `@mnemora/postgres` /
 * `@mnemora/anthropic` の5つ、いずれも `"type": "module"`）の**ビルド後の配布物**
 * （`packages/<name>/dist` 配下の `.js` / `.cjs` / `.mjs`）を、ts-jest 相当の変換に通してから
 * CommonJS として構文解析できることを検査する門。
 *
 * **なぜこの門が要るか（Issue #110）**
 *
 * `@mnemora/postgres` は ESM 専用だが、`packages/postgres/src/migrate.ts` がトップレベルで
 * `import.meta.url` を使っていたため、CommonJS へトランスパイルするテストランナー
 * （NestJS + jest + ts-jest 等）から `@mnemora/postgres` を読み込めない、という実報告があった。
 *
 * 実測して確かめた事実（`packages/postgres/src/migrations-dir.cts` 冒頭のコメントにも記録がある）:
 *
 * - `import.meta` は CommonJS として解析されると **early error**
 *   （構文解析の時点の `SyntaxError: Cannot use 'import.meta' outside a module`）になる。
 *   関数の中に在っても、呼ばなくても、読み込んだ時点で落ちる。
 *   「遅延評価にすれば直る」は誤り。
 * - TypeScript の `transpileModule`（= ts-jest の実体）は `module: CommonJS` でも
 *   `import.meta` を**そのまま素通しする**——ここで検出しないかぎり、壊れた配布物を
 *   出しても普通の `tsc` の型検査や `node` での実行では気づけない
 *   （素の Node の ESM 実行や `require(esm)` は通る。壊れるのは CJS へ変換する経路だけ）。
 *
 * **なぜ `vm.compileFunction` を使うか（`grep "import.meta"` ではなく）**
 *
 * `vm.compileFunction` は構文解析だけを行い、コードを一切実行しない
 * （副作用は起きない）。`grep` と違って、変数経由の埋め込み・折り返しで割れた文・
 * 行内の装飾・**コメントの中の文字列**で誤検知も見逃しもしない——見ているのは
 * 実際にテストランナーが踏む構文解析そのものである。
 * （`packages/postgres/dist/migrations-dir.cjs` は、なぜ `import.meta` を避けたかを
 * 説明する doc コメントの中に `import.meta` という文字列を複数回含む。`grep` ベースの門は
 * ここで誤って赤くなる。この門はそうならないことを
 * `scripts/__tests__/check-cjs-transpile-parse.test.mjs` で固定してある。）
 *
 * **なぜソースではなく `dist/`（ビルド後）を見るか**
 *
 * テストランナーが実際に `require()` するのはビルド後の配布物であり、`src/*.ts` ではない。
 * ソースの時点で問題が無くても、ビルド設定や依存の書き方次第で配布物側に問題が
 * 再発することはありうる——測るべきは「使う側が実際に受け取るもの」である。
 *
 * **対象パッケージのリストをここに複製しない理由**
 *
 * publish 対象と対象外（ルートの `mnemora` / `@mnemora/example-chat`）を分ける機械的な
 * 目印は無い（`scripts/check-publish-pack.mjs` 冒頭の議論と同じ事情）。ADR 0066 が
 * 「対象は `./publish-targets.mjs` の `PUBLISH_TARGETS` に一箇所へ集める」と決めており、
 * この門もそれに従う——ここに2つ目の固定リストを書けば、いずれ2つが食い違う。
 *
 * **`dist` が無い・検査対象が0件のときに黙って緑にしない理由**
 *
 * この門の目的は「ビルド後の配布物が壊れていないこと」の確認である。ビルドを忘れた
 * （＝配布物が無い）状態や、対象を1つも見つけられなかった状態は「確認していない」の
 * であって「確認して問題が無かった」ではない。`scripts/run-db-tests.mjs` が
 * DATABASE_URL 未設定時にそうしているように「実行していない」を緑のまま伝える設計も
 * この repo には在るが、それは既存のジョブ構成が別の場所で本物を担保しているからである
 * （postgres / example-chat ジョブ）。この門にはその代わりが無い——ビルド忘れは
 * そのまま「検査していないのに緑」になる。だからここは非0で落とす。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const BANNER = "─".repeat(72);

/**
 * ルートの `typescript`（`transpileModule` = ts-jest の実体）を読む。
 * root の devDependencies に在るのでそれを使うが、万一 pnpm の配置事情で root から
 * 解決できない環境向けに、`packages/postgres/node_modules` 経由の借用も後退路として持つ
 * （どちらも pnpm ワークスペースが実際にインストールした同じ `typescript` を指す）。
 */
async function loadTypeScript() {
  try {
    return (await import("typescript")).default;
  } catch {
    const require = createRequire(join(repoRoot, "packages", "postgres", "package.json"));
    return require("typescript");
  }
}

/**
 * 検査対象のパッケージ群が置かれた親ディレクトリ。既定はこの repo の `packages/`。
 *
 * テスト（`scripts/__tests__/check-cjs-transpile-parse.test.mjs`）は、本物の
 * `packages/<name>/dist` を汚さずに「dist が無い」「対象0件」「壊れた配布物」を作るため、
 * 一時ディレクトリに `<tmp>/<パッケージ名>/dist/...` という同じ形を作り、
 * この環境変数でそこを指す。CLI の通常呼び出しでは未設定でよい。
 */
const packagesRoot = process.env.CJS_PARSE_CHECK_PACKAGES_ROOT
  ? resolve(process.env.CJS_PARSE_CHECK_PACKAGES_ROOT)
  : join(repoRoot, "packages");
const displayRoot = process.env.CJS_PARSE_CHECK_PACKAGES_ROOT
  ? resolve(packagesRoot, "..")
  : repoRoot;

/** `.d.ts` / `.d.cts` / `.d.mts` を除いた `.js` / `.cjs` / `.mjs` を dist 配下から再帰的に集める。 */
function listDistFiles(distDir) {
  if (!existsSync(distDir)) return [];
  return readdirSync(distDir, { recursive: true })
    .map((rel) => join(distDir, rel))
    .filter((abs) => statSync(abs).isFile())
    .filter((abs) => /\.(?:js|cjs|mjs)$/.test(abs));
}

console.log(
  [
    "",
    BANNER,
    `CJS 構文解析の門: 対象${PUBLISH_TARGETS.length}パッケージのビルド後配布物（packages/*/dist）を`,
    "ts-jest 相当の変換に通してから CommonJS として構文解析します（Issue #110）",
    "",
    "  対象:",
    ...PUBLISH_TARGETS.map((t) => `    - ${t.name} (${basename(t.dir)}/dist)`),
    BANNER,
    "",
  ].join("\n"),
);

const missingDist = [];
/** @type {{ target: string; file: string }[]} */
const targetFiles = [];

for (const target of PUBLISH_TARGETS) {
  const distDir = join(packagesRoot, basename(target.dir), "dist");
  if (!existsSync(distDir)) {
    missingDist.push(target.name);
    continue;
  }
  for (const file of listDistFiles(distDir)) {
    targetFiles.push({ target: target.name, file });
  }
}

if (missingDist.length > 0) {
  console.log(
    [
      "",
      BANNER,
      `✖ dist が見つかりません: ${missingDist.join(", ")}`,
      "",
      "  この門はビルド後の配布物を検査するものであり、dist が無いパッケージがあると",
      "  「検査していないのに緑」になってしまいます。先に `pnpm run build` を打ってください。",
      BANNER,
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (targetFiles.length === 0) {
  console.log(
    [
      "",
      BANNER,
      "✖ 検査対象のファイルが1件も見つかりませんでした（.js / .cjs / .mjs が0件）",
      "",
      "  対象0件のまま緑にする門は、空振りしていても気づけません。",
      BANNER,
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const ts = await loadTypeScript();

/** @type {{ target: string; file: string; error: Error }[]} */
const violations = [];

for (const { target, file } of targetFiles) {
  const source = readFileSync(file, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;

  try {
    // 構文解析だけを行う——実行しない。副作用は起きない。
    vm.compileFunction(transpiled, ["exports", "require", "module", "__filename", "__dirname"], {
      filename: file,
    });
  } catch (error) {
    violations.push({ target, file, error });
  }
}

if (violations.length > 0) {
  const lines = violations.flatMap(({ target, file, error }) => {
    const displayPath = relative(displayRoot, file);
    return [
      `✖ ${displayPath} は CommonJS として解析できません`,
      `    ${error.constructor.name}: ${error.message}`,
      `  ⟹ CJS へ変換するテストランナー（ts-jest 等）から ${target} を読み込めなくなります（Issue #110）。`,
      "     import.meta は CJS では構文解析の時点で落ちるため、関数の中へ移しても直りません。",
      "     自分の位置を知る必要が在るなら、packages/postgres/src/migrations-dir.cts のように",
      "     CommonJS のファイルへ追い出してください。",
      "",
    ];
  });

  console.log(
    ["", BANNER, `✖ 違反が ${violations.length} 件見つかりました`, "", ...lines, BANNER, ""].join(
      "\n",
    ),
  );
  process.exit(1);
}

console.log(
  [
    "",
    BANNER,
    `✔ ${targetFiles.length} 個の配布物が CommonJS として解析できました。`,
    BANNER,
    "",
  ].join("\n"),
);

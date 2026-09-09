import { join } from "node:path";

/**
 * `migrations/*.sql` が置かれたディレクトリを、**このファイル自身の位置から**解決する
 * （Issue #110）。
 *
 * ## なぜ `.cts`（CommonJS）なのか
 *
 * このパッケージは ESM 専用（`"type": "module"`）であり、自分の位置を知る素直な手段は
 * `import.meta.url` である。実際、この定数は `./migrate.ts` のトップレベルで
 * `dirname(fileURLToPath(import.meta.url))` として解決されていた。
 *
 * **しかし `import.meta` は、CommonJS として解析されると構文解析の時点で落ちる。**
 * `SyntaxError: Cannot use 'import.meta' outside a module` は実行時エラーではなく
 * **early error** であり、**`import.meta` が関数の中に在っても、その関数を一度も
 * 呼ばなくても、ファイルを読み込んだ時点で落ちる**（＝「遅延評価にすれば直る」は誤り。
 * `scripts/check-cjs-transpile-parse.mjs` がこれを実測する歯になっている）。
 *
 * これは机上の話ではない。CommonJS へトランスパイルするテストランナー
 * （NestJS + jest + ts-jest 等）は `import` / `export` を `require` / `exports` へ
 * 変換できるが、**`import.meta` には CommonJS の等価構文が無いため素通しする**。
 * 結果、`dist/index.js` は `./migrate.js` を再 export しているので、
 * **`@mnemora/postgres` を import しただけで落ちる**（Issue #110 の実報告）。
 * 素の Node の `require()`（Node 22.12+ の require(esm)）は通るため、
 * **本番の経路は壊れていない**——壊れるのは CJS へ変換する経路だけである。
 *
 * ⟹ **自分の位置を知る処理だけを、CommonJS のこのファイルへ追い出す。**
 * `__dirname` は CommonJS の構文ではなく**ただの変数**なので、どちらの世界でも
 * 構文解析を妨げない。ESM 側からは普通に `import` できる（Node は ESM から CJS の
 * 読み込みを許しており、`exports.DEFAULT_MIGRATIONS_DIR = ...` は
 * cjs-module-lexer が名前付き export として検出する）。
 *
 * ## これはデュアルビルドではない
 *
 * `package.json` の `exports` も `"type": "module"` も変えていない。使う側の import の
 * 書き方も1文字も変わらない。**公開契約は同一**であり、変わるのは「内部の定数を1つ
 * どう計算するか」だけである。CJS の入口を公式に増やす（デュアルビルド）判断とは別物。
 *
 * ## 採らなかった案
 *
 * - **関数の中へ遅延させる**（報告者の提案1）: 上記のとおり early error なので効かない。
 * - **`eval("import.meta.url")`**: 構文解析は通るが、CJS へ変換した利用側が既定の
 *   migrations ディレクトリを**実際に使ったとき**に落ちる。**大きな声で落ちるものを、
 *   遅れて静かに落ちるものに変える**ため採らない。
 */
export const DEFAULT_MIGRATIONS_DIR = join(__dirname, "..", "migrations");

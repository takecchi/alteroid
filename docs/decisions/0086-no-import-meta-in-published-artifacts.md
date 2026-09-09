# ADR 0086: 配布物から `import.meta` を消す — CommonJS のサイドカー1枚で、CJS へ変換する利用側に届ける

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-10

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ」と「人から受け取った前提」を
混ぜない（[AGENTS.md](../../AGENTS.md)）。

---

## 文脈

**mnemora にとって初めての、外部からの実利用フィードバックである。**社外の採用検討者が
自分たちの Slack AI エージェントへ `@mnemora/postgres` を入れようとして、2026-09-09 に
[#107](https://github.com/takecchi/mnemora/issues/107) と
[#110](https://github.com/takecchi/mnemora/issues/110) を上げた。

**受け取った前提**（報告の本文。私が裏を取っていないもの）:

- 導入先は NestJS（CommonJS、`module: nodenext`）+ jest + ts-jest、TypeScript 6.0.3
- `node -e "require('@mnemora/postgres')"` は Node 22 / 24 のどちらでも成功する
  （＝ **本番の経路は壊れていない**）
- 導入先の `public` は Prisma のマイグレーション履歴の管理下にあり、mnemora の
  テーブル群は別スキーマへ隔離したい

**⚠ 報告の現物の指摘には、1つ誤りがあった（私が現物で確かめた）。**報告は
「`packages/postgres/src/bin/migrate.ts` がトップレベルで `import.meta.url` を使っている」と
書いているが、**現 `main`（`d2ec8cf`）の `src/bin/migrate.ts` に `import.meta` は1文字も無い。**
実体は `src/migrate.ts` の `DEFAULT_MIGRATIONS_DIR` である。

🔴 **そしてこれは、報告より影響が広いことを意味する。**`src/index.ts` は
`export * from "./migrate.js"` しているので、**壊れるのは bin だけではなく、
`@mnemora/postgres` の入口そのもの**である。報告者が「実行時 import せず `import type` だけに
留める」という回避を採ったのは、この広さと整合する。

---

## 実測1: `import.meta` は、関数の中に在っても落ちる（**私が実行した**）

**報告者の提案1**（「`DEFAULT_MIGRATIONS_DIR` の解決を遅延させ、関数の中へ移す。
トップレベルでなくなれば、少なくとも import しただけで落ちることは無くなります」）
**は、症状を直さない。**

素の Node v22.23.2 で、CommonJS のファイル2つを `require` した結果:

| ファイルの中身                                                                | 結果                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| `const u = import.meta.url;`（トップレベル）                                  | `SyntaxError: Cannot use 'import.meta' outside a module` |
| `function lazy() { return import.meta.url; }`（**関数の中。一度も呼ばない**） | **同じ `SyntaxError`**                                   |

⟹ **`import.meta` は early error である。**構文解析の時点で落ちるので、
**スコープを動かしても、その関数を呼ばなくても、ファイルを読み込んだ時点で落ちる。**

### 実測2: ts-jest 相当の経路でも同じ（**私が実行した**）

ts-jest の実体は TypeScript の `transpileModule` である。リポジトリの TypeScript 5.9.3 で
`src/migrate.ts` を `module: CommonJS` に変換すると、`import.meta` は**そのまま素通しされる**:

```
exports.DEFAULT_MIGRATIONS_DIR = (0, node_path_1.join)((0, node_path_1.dirname)((0, node_url_1.fileURLToPath)(import.meta.url)), "..", "migrations");
```

これを `vm.compileFunction`（＝ V8 の CommonJS パーサ）に掛けると:

```
SyntaxError: Cannot use 'import.meta' outside a module
```

**遅延化した版**（`import.meta` を関数の中に入れただけの版）を同じ経路に通しても、
**同じ SyntaxError で落ちる。**⟹ 提案1では直らない。

---

## 決定

**自分の位置を知る処理だけを、CommonJS の小さなファイルへ追い出す。**

`packages/postgres/src/migrations-dir.cts`（`.cts` なので `tsc` は `dist/migrations-dir.cjs` を
出す）を新設し、`__dirname` で解決する。`src/migrate.ts` はそこから import して、
`DEFAULT_MIGRATIONS_DIR` を**同じ名前で再 export する。**

**`__dirname` は構文ではなく、ただの変数である。**だから ESM としても CommonJS としても
**構文解析を妨げない。**Node は ESM から CJS の読み込みを許しており、
`exports.DEFAULT_MIGRATIONS_DIR = ...` は cjs-module-lexer が名前付き export として検出する。

### 4つの経路で確かめた（**私が実行した**）

| 経路                                                                    | 結果                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------- |
| `tsc` でビルドした `dist` を素の Node が ESM として読む                 | ✅ `.../packages/postgres/migrations`（`.sql` 7件） |
| 同じ `dist` を CommonJS から `require()`（Node 22.12+ の require(esm)） | ✅ 同じ値                                           |
| vitest（vite が `src` を処理する）                                      | ✅ 解決できる                                       |
| `tsx src/bin/migrate.ts`（`pnpm migrate` の経路）                       | ✅ 解決できる                                       |
| ts-jest 相当（`transpileModule` → V8 の CJS パーサ）                    | ✅ **通る**（現 `main` は SyntaxError）             |

### これはデュアルビルドではない

**`package.json` の `exports` も `"type": "module"` も変えていない。使う側の import の
書き方は1文字も変わらない。**変わるのは「内部の定数を1つどう計算するか」だけである。

⚠ **この線引きはオーナーの判断である**（「私が引いた線が守っているのは**パッケージの
公開契約**である。デュアルビルドを断ったのは、`require()` で CJS として読める入口を
**公式に増やす**こと＝使う側との約束が変わるからだ」）。**公開契約は同一なので、線を
越えていない。**

---

## 採らなかった案

| 案                                                 | 却下の理由                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **遅延評価にする**（報告者の提案1）                | **実測1 のとおり効かない。**early error はスコープを見ない。**⚠ これは当初オーナーが推していた案であり、実測が否定した。**                                                                                                                            |
| **`eval("import.meta.url")` で隠す**               | 構文解析は通る（文字列なので）。しかし CJS へ変換した利用側が既定の migrations ディレクトリを**実際に使ったとき**に落ちる。⟹ **大きな声で落ちるものを、遅れて静かに落ちるものに変える**改修であり、「静かに失敗する形を作らない」という固定点に反する |
| **CJS のデュアルビルド**（報告者の提案3・tsup 等） | **公開契約が変わる。**オーナーの裁量の外の判断であり、今回の射程ではない                                                                                                                                                                              |
| **README に注意書きを置くだけ**（報告者の提案4）   | 直せるものを直さない理由が無い。**注意書きは、直せないときの次善である**                                                                                                                                                                              |
| **`migrationsDir` を必須引数にする**               | 報告者自身が `runMigrations(pool, undefined, { schema })` を使っており、既定の解決を壊すと利用側が壊れる                                                                                                                                              |

---

## 歯（この決定を守るもの）

`scripts/check-cjs-transpile-parse.mjs` を新設した。**ビルド後の `packages/*/dist` を
ts-jest 相当の変換に通してから CommonJS として構文解析し、落ちるものが無いことを検査する。**
CI の `build` ジョブの `Build` の直後で走る（`dist` が無いと落ちる門なので、順序が要る）。

### 🔴 なぜ `grep` で測らないか — 現物の証拠

**`grep "import.meta"` で測る門は、この修正そのものを誤検知して赤くする。**

`src/migrations-dir.cts` の doc コメントは「なぜ `import.meta` を避けたのか」を説明しており、
**`import.meta` という文字列を7回含む。**`tsc` はコメントを落とさないので、
`dist/migrations-dir.cjs` にもその7回がそのまま残る。**構文解析はコメントを読まないので通る。**

⟹ **この門は「形」ではなく「ふるまい」を見る。**`grep` が静かに落とす3つの経路
（変数経由の埋め込み・折り返しで割れた文・行内の装飾）にも当たらない。

⚠ **門が空振りで緑になることを塞いである**: `dist` が無いパッケージが在れば落ち、
検査対象が0件でも落ち、成功時は**検査したファイル数を出す。**

---

## #107（CLI に `--schema` を届ける）は、新しい決定ではない

**[ADR 0057](./0057-dedicated-schema-namespace.md) が既に決めてある**（逐語）:

> 受け口は3つ: `createPostgresClient` / `runMigrations` / `registerEmbeddingSpace`。

**⟹ 同梱 CLI がこの3つに入っていない。**ライブラリ側は `CREATE SCHEMA IF NOT EXISTS` /
`CREATE EXTENSION … WITH SCHEMA` / トランザクション内の `SET LOCAL search_path` / `qualify` に
よる完全修飾まで揃っているのに、**その口である CLI が `runMigrations(pool)` を
オプション無しで呼んでいた。**結果、[ADR 0001](./0001-orm-drizzle.md) が
「マイグレーションの実行はこの1つの口からのみ」と定めた経路を使うと隔離できない、という
状態になっていた。**これは 0057 の取りこぼしであり、決め直すものは何も無い。**

**⚠ ただし1つだけ、ここで新しく決めている**（0057 が決めていないため）:

**指定の優先順位は「コマンドライン引数 > 環境変数 > 未指定」。**報告者は
「CI やコンテナからは環境変数の方が渡しやすい」として環境変数を求めており、両方を
用意する以上、順位を決めて文書化する必要がある。**引数が勝つ**のは、環境変数が
プロセスの外から降ってくるのに対し、引数はその実行のためにその場で書かれるからである。
既存の慣行とも揃っている（`MNEMORA_PROVIDER_SOURCE` 等、`MNEMORA_` 接頭辞は既に広く使われ、
「明示された指定を最優先する」形になっている）。

**`--extension-schema` だけを指定して `--schema` を指定しない場合はエラーにする**
（終了コード 1）。0057 が `extensionSchema` を「`schema` を指定したときだけ効く」と
決めているため、黙って無視すると**「拡張の置き場所を変えたつもりで実は変わっていない」**
という気付きにくい事故になる。**静かに無視しない。**

---

## 引き受ける負債

1. **ESM 専用のパッケージの中に、CommonJS のファイルが1枚在る。**公開契約は変わらないが、
   **「ここに足せばいい」と読まれると、なし崩しにデュアルビルドへ育ちうる。**
   ⟹ このファイルは**自分の位置を知るためだけ**に在る。他の用途で `.cts` を増やすときは、
   この ADR を読み直すこと。
2. **`import.meta` を避ける理由は、mnemora 自身の都合ではない。**素の Node では
   `import.meta.url` の方が素直である。**他所のツールチェーンの制約を、こちらの
   ソースの形として引き受けている。**
3. **`packages/postgres` 以外の4パッケージには、今日 `import.meta` は無い**（門が全件を
   見て確かめる）。**しかし「無いこと」は設計ではなく、たまたまである。**門がそれを
   設計に変える。

---

## これが覆るとしたら

- **ts-jest（TypeScript の `transpileModule`）が `import.meta` を CommonJS 向けに
  変換できるようになったら**——`import.meta.url` を素直に使う形へ戻してよい。
  ⚠ ただし戻すのは、変換できない版のツールを使う利用側が居なくなってからである。
- **mnemora が CJS のデュアルビルドを出すと決めたら**——この ADR の前提（公開契約を
  変えない）が消えるので、サイドカーは要らなくなる。**その判断はオーナーのものであり、
  本 ADR はそれを先取りしない。**
- **`migrations/*.sql` を配布物に同梱するのをやめたら**（例: SQL を TypeScript に埋め込む）
  ——自分の位置を知る必要そのものが消える。

#!/usr/bin/env node
/**
 * `pnpm build` の一環として OpenAPI spec をリポジトリへ書き出す。
 *
 * **「先に生成コマンドを流す」という人間の手順を増やさないこと**（Issue #20
 * 受け入れ基準4）。`tsup` の直後にこれを走らせる（`package.json` の `build`）ので、
 * `pnpm install && pnpm build` だけで `openapi.json` が最新化される。
 *
 * `dist/openapi.js` を import する（ソースの `.ts` ではない）。デーモンを起動
 * せずに spec を作れるのは `buildOpenApiDocument`（`src/openapi.ts`）がスタブの
 * deps で `createApp` を呼ぶからで、それ自体は tsup の出力を前提にしている
 * （このスクリプトは常にビルド後に走る）。
 */
import { writeFile } from 'node:fs/promises';
// `URL` を明示 import する（グローバルの `URL`/`process` に頼ると、この
// スクリプトが .mjs で ESLint の TS 向け設定（no-undef 無効化）の外に居るため
// lint が「未定義」と誤検知する）。
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

// リポジトリの `pnpm format:check`（prettier）を通す書式で書き出す。単純な
// `JSON.stringify(doc, null, 2)` はプリティアが1行に収める短い配列
// （`"required": ["ok", "pid"]` など）も1要素1行に展開してしまい、そのままでは
// format:check に落ちる。prettier 自身で整形すれば、`.prettierrc.json` が
// 変わってもここを直さずに追従する。
import { format, resolveConfig } from 'prettier';

import { buildOpenApiDocument } from '../dist/openapi.js';

const outputPath = fileURLToPath(new URL('../openapi.json', import.meta.url));
const document = await buildOpenApiDocument();

const config = (await resolveConfig(outputPath)) ?? {};
const formatted = await format(`${JSON.stringify(document, null, 2)}\n`, {
  ...config,
  filepath: outputPath,
});

await writeFile(outputPath, formatted);

process.stdout.write(`alteroidd: openapi.json を書き出しました (${outputPath})\n`);

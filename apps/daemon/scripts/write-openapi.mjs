#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
// `process` / `URL` を明示 import する: .mjs は ESLint の TS 向け設定（no-undef 無効化）の外で、グローバルに頼ると lint が未定義と誤検知するため。
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

// `JSON.stringify` で書かず prettier で整形する: 短い配列も1要素1行に展開して `format:check` に落ちるため。
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

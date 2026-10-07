#!/usr/bin/env node
// 使い方: pnpm check:web-css-no-inline-fonts（`pnpm build` の後に走らせる）

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  assertHasCssFiles,
  FAILURE_ADVICE,
  findInlineFontHits,
  PATTERNS,
} from './check-web-css-no-inline-fonts-core.mjs';

const ASSETS_DIR = join(import.meta.dirname, '..', 'apps', 'web', 'build', 'client', 'assets');

function listCssFiles(dir) {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && path.endsWith('.css'));
}

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function main() {
  let paths;
  try {
    paths = listCssFiles(ASSETS_DIR);
  } catch (error) {
    logError(
      `check-web-css-no-inline-fonts: ${ASSETS_DIR} を読めない（先に \`pnpm build\` を走らせたか）: ${error}`,
    );
    process.exitCode = 1;
    return;
  }

  const files = paths.map((path) => ({ path, content: readFileSync(path, 'utf8') }));

  const empty = assertHasCssFiles(files);
  if (empty !== null) {
    logError(`check-web-css-no-inline-fonts: ${ASSETS_DIR} に${empty}`);
    process.exitCode = 1;
    return;
  }

  const hits = findInlineFontHits(files);

  if (hits.length > 0) {
    const total = hits.reduce((sum, hit) => sum + hit.count, 0);
    logError(
      `check-web-css-no-inline-fonts: NG — フォントの base64 埋め込みが計${total}個ある（${hits.length}件のパターン別ヒット）:`,
    );
    for (const hit of hits) {
      logError(`  ${hit.path} : ${hit.pattern} ${hit.count}個`);
      logError(`    …${hit.snippet}…`);
    }
    logError(FAILURE_ADVICE);
    process.exitCode = 1;
    return;
  }

  log(
    `check-web-css-no-inline-fonts: OK — ${files.length}ファイル / ${PATTERNS.length}パターンとも0件`,
  );
}

main();

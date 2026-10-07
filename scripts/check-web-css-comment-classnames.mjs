#!/usr/bin/env node
// 使い方: pnpm check:web-css-comment-classnames（`pnpm build` の後に走らせる）

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { findInvalidCssHits, PATTERNS } from './check-web-css-comment-classnames-core.mjs';

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
      `check-web-css-comment-classnames: ${ASSETS_DIR} を読めない（先に \`pnpm build\` を走らせたか）: ${error}`,
    );
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    logError(
      `check-web-css-comment-classnames: ${ASSETS_DIR} に .css が1つも無い（build が壊れていないか）`,
    );
    process.exitCode = 1;
    return;
  }

  const files = paths.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
  const hits = findInvalidCssHits(files);

  if (hits.length > 0) {
    logError(
      `check-web-css-comment-classnames: NG — ${hits.length}件のプレースホルダ混入が見つかった:`,
    );
    for (const hit of hits) {
      logError(`  ${hit.path} : ${hit.pattern}`);
      logError(`    …${hit.snippet}…`);
    }
    process.exitCode = 1;
    return;
  }

  log(
    `check-web-css-comment-classnames: OK — ${files.length}ファイル / ${PATTERNS.length}パターンとも0件`,
  );
}

main();

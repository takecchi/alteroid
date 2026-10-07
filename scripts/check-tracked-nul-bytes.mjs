#!/usr/bin/env node
// 対象を `git` が扱うファイルに限る: `node_modules` や生成物を歩かないため。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  findNulByteHits,
  isPngImage,
  listScannableFiles,
} from './check-tracked-nul-bytes-core.mjs';

const ROOT = join(import.meta.dirname, '..');

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function main() {
  let paths;
  try {
    paths = listScannableFiles(ROOT);
  } catch (error) {
    logError(`check-tracked-nul-bytes: \`git ls-files\` を実行できない: ${error}`);
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    logError('check-tracked-nul-bytes: 対象ファイルが0件（git repo の外で走らせていないか）');
    process.exitCode = 1;
    return;
  }

  const files = [];
  const skippedImages = [];
  for (const path of paths) {
    let content;
    try {
      const bytes = readFileSync(join(ROOT, path));
      if (isPngImage(path, bytes)) {
        skippedImages.push(path);
        continue;
      }
      content = bytes.toString('utf8');
    } catch (error) {
      // 読めないものは検査対象から外してその旨を出す: 黙ってスキップしないため。
      logError(`check-tracked-nul-bytes: ${path} を読めないため検査から外す: ${error}`);
      continue;
    }
    files.push({ path, content });
  }

  const hits = findNulByteHits(files);

  if (hits.length > 0) {
    logError(`check-tracked-nul-bytes: NG — ${hits.length}件のNULバイト混入が見つかった:`);
    for (const hit of hits) {
      logError(`  ${hit.path} (offset ${hit.index})`);
      logError(`    …${hit.snippet}…`);
    }
    process.exitCode = 1;
    return;
  }

  log(
    `check-tracked-nul-bytes: OK — ${files.length}ファイルとも0件` +
      `（PNG の画像 ${skippedImages.length}件は検査から外した）`,
  );
}

main();

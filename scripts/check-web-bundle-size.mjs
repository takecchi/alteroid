#!/usr/bin/env node
// 閾値を単一チャンクと総量の2本立てにする: 事故の形が1ルートだけの桁違いの膨張で、総量だけだと1本の暴走が埋もれ、単一だけだとじわじわの増加を取り逃すため。
// 落ちたときは超過したチャンク・全チャンクの一覧・使用率・「閾値を上げる前に原因を特定すること」を出す: 「予算超過」だけだと原因を見ずに閾値を上げて通してしまうため。

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  judgeBundleSize,
  SINGLE_CHUNK_MAX_BYTES,
  TOTAL_MAX_BYTES,
} from './check-web-bundle-size-core.mjs';

const ASSETS_DIR = join(import.meta.dirname, '..', 'apps', 'web', 'build', 'client', 'assets');
const ISSUE_URL = 'https://github.com/takecchi/alteroid/issues/335';

function listJsFiles(dir) {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && path.endsWith('.js'));
}

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function formatBytes(n) {
  return n.toLocaleString('en-US') + ' B';
}

function formatPercent(n) {
  return Math.round(n) + '%';
}

function basename(path) {
  return path.split('/').pop();
}

function main() {
  let paths;
  try {
    paths = listJsFiles(ASSETS_DIR);
  } catch (error) {
    logError(
      `check-web-bundle-size: ${ASSETS_DIR} を読めない（先に \`pnpm build\` を走らせたか）: ${error}`,
    );
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    logError(`check-web-bundle-size: ${ASSETS_DIR} に .js が1つも無い（build が壊れていないか）`);
    process.exitCode = 1;
    return;
  }

  const files = paths.map((path) => ({ path: basename(path), bytes: statSync(path).size }));
  const result = judgeBundleSize(files);

  if (!result.ok) {
    logError(`check-web-bundle-size: NG — チャンクのサイズ予算を超えた`);

    if (result.oversized.length > 0) {
      logError('');
      logError(`単一チャンクの予算（${formatBytes(SINGLE_CHUNK_MAX_BYTES)}）を超えたチャンク:`);
      for (const hit of result.oversized) {
        logError(
          `  ${hit.path} : ${formatBytes(hit.bytes)}（超過 ${formatBytes(hit.overBytes)} / ` +
            `${formatPercent(hit.overPercent)}）`,
        );
      }
    }

    logError('');
    logError(
      `全チャンク（大きい順、上位${Math.min(10, result.sorted.length)}件 / 全${result.sorted.length}件）:`,
    );
    for (const file of result.sorted.slice(0, 10)) {
      logError(`  ${formatBytes(file.bytes).padStart(12)}  ${file.path}`);
    }

    logError('');
    logError(
      `合計 ${formatBytes(result.totalBytes)} / 予算 ${formatBytes(TOTAL_MAX_BYTES)}` +
        `（${formatPercent(result.totalBudgetUsedPercent)}）${result.totalOver ? ' — 超過' : ''}`,
    );

    logError('');
    logError(`次にすること: 閾値を上げる前に、増えた原因を特定すること（${ISSUE_URL}）`);

    process.exitCode = 1;
    return;
  }

  // 使用率も出す: 「OK」だけだと、予算の99%を使っていても緑に見えるため。
  log(
    `check-web-bundle-size: OK — ${files.length}ファイル / 最大 ${formatBytes(result.maxChunk.bytes)}` +
      `（予算の ${formatPercent(result.singleBudgetUsedPercent)}）/ ` +
      `合計 ${formatBytes(result.totalBytes)}（予算の ${formatPercent(result.totalBudgetUsedPercent)}）`,
  );
}

main();

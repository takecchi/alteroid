#!/usr/bin/env node
// 対象を `git` が扱うファイルに限る: `node_modules` や生成物を歩かないため。`docs/` の散文は人が読む記録で、クローンの道具の説明文ではないので扱わない。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  findStaleTokenAdviceHits,
  listScannableSources,
} from './check-stale-token-restart-advice-core.mjs';

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
    paths = listScannableSources(ROOT);
  } catch (error) {
    logError(`check-stale-token-restart-advice: \`git ls-files\` を実行できない: ${error}`);
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    logError('check-stale-token-restart-advice: 対象が0件（git repo の外で走らせていないか）');
    process.exitCode = 1;
    return;
  }

  const files = [];
  for (const path of paths) {
    try {
      files.push({ path, content: readFileSync(join(ROOT, path), 'utf8') });
    } catch (error) {
      // 読めないものは黙って飛ばさない: 判定できないため。
      logError(`check-stale-token-restart-advice: ${path} を読めないため検査から外す: ${error}`);
    }
  }

  const hits = findStaleTokenAdviceHits(files);

  if (hits.length > 0) {
    logError(`check-stale-token-restart-advice: NG — 生成元の外に${hits.length}件の字面が在る:`);
    for (const hit of hits) {
      logError(`  ${hit.path}:${hit.line}  「${hit.text}」`);
      logError(`    ⟹ ${hit.why}`);
    }
    logError(
      '  字面の生成元は packages/core/src/usage-limits.ts の STALE_TOKEN_RESTART_ADVICE 1箇所である（Issue #1175）。',
    );
    process.exitCode = 1;
    return;
  }

  log(`check-stale-token-restart-advice: OK — ${files.length}ファイルとも生成元の外に字面なし`);
}

main();

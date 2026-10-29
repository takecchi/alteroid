// 字面の再掲を禁じる検査の入口に共通の手順。対象を `git` が扱うファイルに限る: `node_modules` や生成物を歩かないため。`docs/` の散文は人が読む記録で、クローンの道具の説明文ではないので扱わない。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { listScannableSources } from './banned-phrase-check-core.mjs';
import { log, logError } from './cli-log.mjs';

const ROOT = join(import.meta.dirname, '..');

export function runBannedPhraseCheck({ name, findHits, generatorNote }) {
  let paths;
  try {
    paths = listScannableSources(ROOT);
  } catch (error) {
    logError(`${name}: \`git ls-files\` を実行できない: ${error}`);
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    logError(`${name}: 対象が0件（git repo の外で走らせていないか）`);
    process.exitCode = 1;
    return;
  }

  const files = [];
  for (const path of paths) {
    try {
      files.push({ path, content: readFileSync(join(ROOT, path), 'utf8') });
    } catch (error) {
      // 読めないものは黙って飛ばさない: 判定できないため。
      logError(`${name}: ${path} を読めないため検査から外す: ${error}`);
    }
  }

  const hits = findHits(files);

  if (hits.length > 0) {
    logError(`${name}: NG — 生成元の外に${hits.length}件の字面が在る:`);
    for (const hit of hits) {
      logError(`  ${hit.path}:${hit.line}  「${hit.text}」`);
      logError(`    ⟹ ${hit.why}`);
    }
    logError(`  ${generatorNote}`);
    process.exitCode = 1;
    return;
  }

  log(`${name}: OK — ${files.length}ファイルとも生成元の外に字面なし`);
}

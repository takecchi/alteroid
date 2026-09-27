#!/usr/bin/env node
/**
 * 「manager_start で起こし直す前に確かめろ」という向きの助言が、生成元1箇所の
 * 外で書かれていないかを見る（Issue #1287）。**なぜ要るか・何を免除しているかは
 * `check-restart-before-check-advice-core.mjs` の doc に書いてある。**
 *
 * ここは「対象を列挙して、読んで、渡して、終了コードを決める」だけ
 * （`check-stale-token-restart-advice.mjs` と同じ分け方）。
 *
 * **対象を `git`（追跡済み + 未追跡だが ignore されていないファイル）に限る**
 * のは、`node_modules` や生成物を歩かないため。拡張子は `.ts` / `.mjs` / `.js`
 * に絞る——助言はソースの中の文字列として配られるものであり、`docs/` の散文
 * （正典）はここでは扱わない。
 *
 * **以前は `git ls-files -z`（追跡済みだけ）だった。** まだ `git add` していない
 * 新規ファイルに生成元の外の字面を書いても、手元の `pnpm verify` は緑のまま、
 * push 後の CI で初めて赤くなる穴があった（Issue #1817。`listScannableSources`
 * の歯は `scripts/check-restart-before-check-advice.test.ts` に在る）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  findRestartBeforeCheckAdviceHits,
  listScannableSources,
} from './check-restart-before-check-advice-core.mjs';

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
    logError(`check-restart-before-check-advice: \`git ls-files\` を実行できない: ${error}`);
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    logError('check-restart-before-check-advice: 対象が0件（git repo の外で走らせていないか）');
    process.exitCode = 1;
    return;
  }

  const files = [];
  for (const path of paths) {
    try {
      files.push({ path, content: readFileSync(join(ROOT, path), 'utf8') });
    } catch (error) {
      // 読めないものは判定できない。**黙って飛ばさない**（AGENTS.md「静かに失敗する道具」）。
      logError(`check-restart-before-check-advice: ${path} を読めないため検査から外す: ${error}`);
    }
  }

  const hits = findRestartBeforeCheckAdviceHits(files);

  if (hits.length > 0) {
    logError(`check-restart-before-check-advice: NG — 生成元の外に${hits.length}件の字面が在る:`);
    for (const hit of hits) {
      logError(`  ${hit.path}:${hit.line}  「${hit.text}」`);
      logError(`    ⟹ ${hit.why}`);
    }
    logError(
      '  字面の生成元は packages/core/src/usage-limits.ts の RESTART_BEFORE_CHECK_ADVICE / ' +
        'RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN 1箇所である（Issue #1287）。',
    );
    process.exitCode = 1;
    return;
  }

  // **必ず1行出す**（出ていなければ走っていないと読める）。
  log(`check-restart-before-check-advice: OK — ${files.length}ファイルとも生成元の外に字面なし`);
}

main();

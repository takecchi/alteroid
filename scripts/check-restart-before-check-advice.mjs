#!/usr/bin/env node
/**
 * 「manager_start で起こし直す前に確かめろ」という向きの助言が、生成元1箇所の
 * 外で書かれていないかを見る（Issue #1287）。**なぜ要るか・何を免除しているかは
 * `check-restart-before-check-advice-core.mjs` の doc に書いてある。**
 *
 * ここは「`git ls-files` で列挙して、読んで、渡して、終了コードを決める」だけ
 * （`check-stale-token-restart-advice.mjs` と同じ分け方）。
 *
 * **対象を `git ls-files` に限る**のは、`node_modules` や生成物を歩かないため。
 * 拡張子は `.ts` / `.mjs` / `.js` に絞る——助言はソースの中の文字列として配られる
 * ものであり、`docs/` の散文（正典）はここでは扱わない。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { findRestartBeforeCheckAdviceHits } from './check-restart-before-check-advice-core.mjs';

const ROOT = join(import.meta.dirname, '..');

/** 助言が文字列として載りうる拡張子。 */
const TARGET_SUFFIXES = ['.ts', '.mjs', '.js'];

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function listTrackedSources() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    maxBuffer: 1024 * 1024 * 64,
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0)
    .filter((path) => TARGET_SUFFIXES.some((suffix) => path.endsWith(suffix)));
}

function main() {
  let paths;
  try {
    paths = listTrackedSources();
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

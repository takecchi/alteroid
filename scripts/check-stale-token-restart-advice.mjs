#!/usr/bin/env node
/**
 * 「世代ずれなら起こし直せ」の助言が、生成元1箇所の外で書かれていないかを見る
 * （Issue #1175）。**なぜ要るか・何を免除しているかは
 * `check-stale-token-restart-advice-core.mjs` の doc に書いてある。**
 *
 * ここは「対象を列挙して、読んで、渡して、終了コードを決める」だけ
 * （`check-tracked-nul-bytes.mjs` と同じ分け方）。
 *
 * **対象を `git`（追跡済み + 未追跡だが ignore されていないファイル）に限る**
 * のは、`node_modules` や生成物を歩かないため。拡張子は `.ts` / `.mjs` / `.js` /
 * `.tsx` / `.jsx`（`apps/web` の React コンポーネントを含む。Issue #1873）
 * に絞る——助言はソースの中の文字列として配られるものであり、`docs/` の散文
 * （正典）はここでは扱わない（あちらは人が読む記録で、クローンの道具の説明文
 * ではない）。
 *
 * **以前は `git ls-files -z`（追跡済みだけ）だった。** まだ `git add` していない
 * 新規ファイルに生成元の外の字面を書いても、手元の `pnpm verify` は緑のまま、
 * push 後の CI で初めて赤くなる穴があった（Issue #1817。`listScannableSources`
 * の歯は `scripts/check-stale-token-restart-advice.test.ts` に在る）。
 */

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
      // 読めないものは判定できない。**黙って飛ばさない**（AGENTS.md「静かに失敗する道具」）。
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

  // **必ず1行出す**（出ていなければ走っていないと読める）。
  log(`check-stale-token-restart-advice: OK — ${files.length}ファイルとも生成元の外に字面なし`);
}

main();

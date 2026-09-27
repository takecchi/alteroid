#!/usr/bin/env node
/**
 * 追跡済み + 未追跡だが ignore されていないファイルに NUL バイト
 * （コードポイント0）が混入していないかを見る（#260、Issue #1817）。
 *
 * ## なぜ要るか
 *
 * 編集したファイルのスペース1文字が NUL バイトに化けた事故が2回起きている
 * （#260 本文）。原因は未特定・再現不能で、この Issue の終了条件は「原因の
 * 切り分け」または「検出の仕組み」のどちらか（2026-08-26 のオーナーコメント）。
 * ここでは検出のほうを入れる。
 *
 * ## `check-web-bundle-node-traces.mjs` / `check-web-css-comment-classnames.mjs`
 * との違い
 *
 * あちらは `apps/web` のビルド生成物（`pnpm build` 後にしか存在しない）を見る。
 * こちらは対象ファイルそのものを見るので、`pnpm build` を要らず、素の
 * `pnpm test` だけで走る。**対象を git（追跡済み + 未追跡だが ignore されて
 * いないファイル）に限るのは、`node_modules` や生成物（`apps/web/build` 等）を
 * 歩かないため**（それらは追跡外か `.gitignore` 済みで、混入しても実害が repo
 * に残らない）。
 *
 * **以前は `git ls-files -z`（追跡済みだけ）だった。** まだ `git add` していない
 * 新規ファイルに NUL バイトが混入しても、手元の `pnpm verify`（実体は
 * `pnpm test`）は緑のまま、push 後の CI で初めて赤くなる穴があった（Issue
 * #1817。歯は `scripts/check-tracked-nul-bytes.test.ts`）。
 *
 * ## 判定ロジックの置き場所
 *
 * パターン定義と走査そのものは `check-tracked-nul-bytes-core.mjs` に切り出して
 * ある（`verify.mjs` / `verify-core.mjs` と同じ分け方 — 理由はそちらの doc）。
 * このファイルは「対象を列挙して、読んで、渡して、終了コードを決める」だけ。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { findNulByteHits, listScannableFiles } from './check-tracked-nul-bytes-core.mjs';

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
  for (const path of paths) {
    let content;
    try {
      content = readFileSync(join(ROOT, path), 'utf8');
    } catch (error) {
      // シンボリックリンクの壊れた参照先など、稀に読めないものがある。
      // 読めないものは「NUL の有無」を判定できないので、検査対象から外し
      // その旨を出す（黙ってスキップしない — AGENTS.md「静かに失敗する道具」）。
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

  // **必ず1行出す**（AGENTS.md「静かに失敗する道具」— 出ていなければ走っていないと読める）。
  log(`check-tracked-nul-bytes: OK — ${files.length}ファイルとも0件`);
}

main();

#!/usr/bin/env node
/**
 * 追跡済みファイル（`git ls-files`）に NUL バイト（コードポイント0）が
 * 混入していないかを見る（#260）。
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
 * こちらは `git ls-files` が返す追跡済みファイルそのものを見るので、
 * `pnpm build` を要らず、素の `pnpm test` だけで走る。**対象を `git ls-files`
 * に限るのは、`node_modules` や生成物（`apps/web/build` 等）を歩かないため**
 * （それらは追跡外か `.gitignore` 済みで、混入しても実害が repo に残らない）。
 *
 * ## 判定ロジックの置き場所
 *
 * パターン定義と走査そのものは `check-tracked-nul-bytes-core.mjs` に切り出して
 * ある（`verify.mjs` / `verify-core.mjs` と同じ分け方 — 理由はそちらの doc）。
 * このファイルは「`git ls-files` で列挙して、読んで、渡して、終了コードを
 * 決める」だけ。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { findNulByteHits } from './check-tracked-nul-bytes-core.mjs';

const ROOT = join(import.meta.dirname, '..');

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

/** `git ls-files -z` で追跡済みファイルの相対パスを列挙する（NUL 区切り＝
 * ファイル名自体に改行等が混ざっても壊れない。皮肉だが対象自体は NUL では
 * 分けられない——パスの中に NUL が来ることは無いため区切りとして安全）。 */
function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    maxBuffer: 1024 * 1024 * 64,
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0);
}

function main() {
  let paths;
  try {
    paths = listTrackedFiles();
  } catch (error) {
    logError(`check-tracked-nul-bytes: \`git ls-files\` を実行できない: ${error}`);
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    logError('check-tracked-nul-bytes: 追跡済みファイルが0件（git repo の外で走らせていないか）');
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
  log(`check-tracked-nul-bytes: OK — 追跡済み${files.length}ファイルとも0件`);
}

main();

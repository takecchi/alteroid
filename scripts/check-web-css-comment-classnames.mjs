#!/usr/bin/env node
/**
 * `apps/web` のビルド生成物（`apps/web/build/client/assets/*.css`）に、
 * コメント中のプレースホルダ記法がクラス名として拾われて生まれた不正な
 * 宣言が入っていないことを見る（#317）。
 *
 * ## なぜ要るか
 *
 * Tailwind のスキャナは、ソースコードの「コメントの中」に書かれたクラス名も
 * 拾う。省略記号などのプレースホルダを混ぜたコメント
 * （`pr-[calc(...+var(--safe-right))]` など）を書くと、コンパイル後の CSS に
 * `padding-right:calc(...+var(--safe-right))` という不正な宣言がそのまま出る
 * （実測は #317 本文、`check-web-css-comment-classnames-core.mjs` の doc）。
 *
 * 不正な宣言はブラウザが黙って捨てるので、**画面には何も起きない。** 気づく
 * 契機が「コンパイル後の CSS を grep する」以外に無かったので、それをここで
 * 機械化する。
 *
 * ## `check-web-bundle-node-traces.mjs` との違い
 *
 * あちらは Node 専用コードの混入（JS）、こちらはコメントの誤拾い（CSS）で
 * 対象も原因も別だが、**「結果側（生成物そのもの）を見る」という形は同じ**
 * なので同じ分け方（CLI 側はファイル読み込みだけ、判定は `-core.mjs` に切り出す）
 * を踏襲した。
 *
 * ## 検査語をどう決めたか・言えること/言えないこと
 *
 * `check-web-css-comment-classnames-core.mjs` の doc が正本。このファイルには
 * 判定ロジックを置かない。
 */

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

// `console` に頼らない理由は `check-web-bundle-node-traces.mjs` と同じ
// （`scripts/verify.mjs` に揃えて `process.std{out,err}.write` を使う）。
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

  // **必ず1行出す**（AGENTS.md「静かに失敗する道具」— 出ていなければ走っていないと読める）。
  log(
    `check-web-css-comment-classnames: OK — ${files.length}ファイル / ${PATTERNS.length}パターンとも0件`,
  );
}

main();

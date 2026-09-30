#!/usr/bin/env node
/**
 * `apps/web` のビルド生成物（`apps/web/build/client/assets/*.css`）に、フォントの
 * base64 埋め込み（`data:font/`）が1つも無いことを見る。
 *
 * ## なぜ要るか
 *
 * `apps/web/vite.config.ts` の `build.assetsInlineLimit` を関数にして、フォントを
 * CSS へ埋め込まないようにした（PR #2357）。前は `root-*.css` に `url(data:font/…)` が
 * 46 個・約 200 KB 入っていた。埋め込みは `unicode-range` に関係なく CSS と一緒に最初に
 * 落ちてくる。この設定が外れる・効かなくなる事故を、原因そのもの（`data:font/`）で
 * 捕まえる。CSS 全体のサイズ予算にしないのは、無関係な CSS の増減で誤って落ちるため
 * （オーナー判断）。
 *
 * 形は `check-web-css-comment-classnames.mjs` と同じ（CLI 側はファイル読み込みだけ、
 * 判定は `-core.mjs`）。判定・言えないことは `check-web-css-no-inline-fonts-core.mjs` の doc。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  assertHasCssFiles,
  FAILURE_ADVICE,
  findInlineFontHits,
  PATTERNS,
} from './check-web-css-no-inline-fonts-core.mjs';

const ASSETS_DIR = join(import.meta.dirname, '..', 'apps', 'web', 'build', 'client', 'assets');

function listCssFiles(dir) {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && path.endsWith('.css'));
}

// `console` に頼らない理由は `check-web-css-comment-classnames.mjs` と同じ。
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
      `check-web-css-no-inline-fonts: ${ASSETS_DIR} を読めない（先に \`pnpm build\` を走らせたか）: ${error}`,
    );
    process.exitCode = 1;
    return;
  }

  const files = paths.map((path) => ({ path, content: readFileSync(path, 'utf8') }));

  const empty = assertHasCssFiles(files);
  if (empty !== null) {
    logError(`check-web-css-no-inline-fonts: ${ASSETS_DIR} に${empty}`);
    process.exitCode = 1;
    return;
  }

  const hits = findInlineFontHits(files);

  if (hits.length > 0) {
    const total = hits.reduce((sum, hit) => sum + hit.count, 0);
    logError(
      `check-web-css-no-inline-fonts: NG — ${hits.length}ファイルに data:font/ が計${total}個ある:`,
    );
    for (const hit of hits) {
      logError(`  ${hit.path} : ${hit.count}個`);
      logError(`    …${hit.snippet}…`);
    }
    logError(FAILURE_ADVICE);
    process.exitCode = 1;
    return;
  }

  // **必ず1行出す**（AGENTS.md「静かに失敗する道具」— 出ていなければ走っていないと読める）。
  log(
    `check-web-css-no-inline-fonts: OK — ${files.length}ファイル / ${PATTERNS.length}パターンとも0件`,
  );
}

main();

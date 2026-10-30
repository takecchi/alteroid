#!/usr/bin/env node
// 使い方: pnpm check:web-build-output（`pnpm build` の後に走らせる）
// `apps/web/build/client/assets` の生成物を見る3つの門（Node 専用の痕跡・CSS のプレースホルダ混入・フォントの base64 埋め込み）を1つの入口で回す。
// 1つが NG でも残りを走らせる: 全部の結果を1回で出すため。1つでも NG なら exitCode=1。
// 判定は各 `*-core.mjs` が持つ（ここは読み出しと表示の骨だけ）。
// node-traces: lint（`@alteroid/core` の値 import 禁止）に絞らず生成物も見る: lint は経路を `@alteroid/core` に固定した歯で、別の依存からの混入には鳴らないため。
// node-traces: `process.env` を検査語にしない: markdown チャンクなど正当なコードに含まれる文字列で誤検知する恐れがあるため。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  findNodeTraceHits,
  PATTERNS as NODE_TRACE_PATTERNS,
} from './check-web-bundle-node-traces-core.mjs';
import {
  findInvalidCssHits,
  PATTERNS as CSS_COMMENT_PATTERNS,
} from './check-web-css-comment-classnames-core.mjs';
import {
  assertHasCssFiles,
  FAILURE_ADVICE as INLINE_FONT_ADVICE,
  findInlineFontHits,
  PATTERNS as INLINE_FONT_PATTERNS,
} from './check-web-css-no-inline-fonts-core.mjs';
import { log, logError } from './cli-log.mjs';
import { listFilesWithExt } from './list-files-with-ext.mjs';

const ASSETS_DIR = join(import.meta.dirname, '..', 'apps', 'web', 'build', 'client', 'assets');

const snippetLines = (hit) => [`  ${hit.path} : ${hit.pattern}`, `    …${hit.snippet}…`];

// `emptyMessage`: 対象が0本のときの文（`null` なら0本でも判定へ進む）。`describeNg`: NG の見出し。`hitLines`: ヒットごとの行。`advice`: NG の末尾に出す助言。
const GATES = [
  {
    name: 'check-web-bundle-node-traces',
    ext: '.js',
    find: findNodeTraceHits,
    patternCount: NODE_TRACE_PATTERNS.length,
    emptyMessage: () => '.js が1つも無い（build が壊れていないか）',
    describeNg: (hits) => `NG — ${hits.length}件のNode専用の痕跡が見つかった:`,
    hitLines: snippetLines,
    advice: null,
  },
  {
    name: 'check-web-css-comment-classnames',
    ext: '.css',
    find: findInvalidCssHits,
    patternCount: CSS_COMMENT_PATTERNS.length,
    emptyMessage: () => '.css が1つも無い（build が壊れていないか）',
    describeNg: (hits) => `NG — ${hits.length}件のプレースホルダ混入が見つかった:`,
    hitLines: snippetLines,
    advice: null,
  },
  {
    name: 'check-web-css-no-inline-fonts',
    ext: '.css',
    find: findInlineFontHits,
    patternCount: INLINE_FONT_PATTERNS.length,
    emptyMessage: (files) => assertHasCssFiles(files),
    describeNg: (hits) => {
      const total = hits.reduce((sum, hit) => sum + hit.count, 0);
      return `NG — フォントの base64 埋め込みが計${total}個ある（${hits.length}件のパターン別ヒット）:`;
    },
    hitLines: (hit) => [`  ${hit.path} : ${hit.pattern} ${hit.count}個`, `    …${hit.snippet}…`],
    advice: INLINE_FONT_ADVICE,
  },
];

// 戻り値は NG かどうか。
function runGate(gate) {
  let paths;
  try {
    paths = listFilesWithExt(ASSETS_DIR, gate.ext);
  } catch (error) {
    logError(
      `${gate.name}: ${ASSETS_DIR} を読めない（先に \`pnpm build\` を走らせたか）: ${error}`,
    );
    return true;
  }

  const files = paths.map((path) => ({ path, content: readFileSync(path, 'utf8') }));

  const empty = gate.emptyMessage(files);
  if (empty !== null && paths.length === 0) {
    logError(`${gate.name}: ${ASSETS_DIR} に${empty}`);
    return true;
  }

  const hits = gate.find(files);
  if (hits.length > 0) {
    logError(`${gate.name}: ${gate.describeNg(hits)}`);
    for (const hit of hits) {
      for (const line of gate.hitLines(hit)) logError(line);
    }
    if (gate.advice !== null) logError(gate.advice);
    return true;
  }

  log(`${gate.name}: OK — ${files.length}ファイル / ${gate.patternCount}パターンとも0件`);
  return false;
}

function main() {
  let failed = false;
  for (const gate of GATES) {
    if (runGate(gate)) failed = true;
  }
  if (failed) process.exitCode = 1;
}

main();

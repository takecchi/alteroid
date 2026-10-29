#!/usr/bin/env node
// lint（`@alteroid/core` の値 import 禁止）に絞らず生成物も見る: lint は経路を `@alteroid/core` に固定した歯で、別の依存からの混入には鳴らないため。
// `process.env` を検査語にしない: markdown チャンクなど正当なコードに含まれる文字列で誤検知する恐れがあるため。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { findNodeTraceHits, PATTERNS } from './check-web-bundle-node-traces-core.mjs';
import { log, logError } from './cli-log.mjs';
import { listFilesWithExt } from './list-files-with-ext.mjs';

const ASSETS_DIR = join(import.meta.dirname, '..', 'apps', 'web', 'build', 'client', 'assets');

function main() {
  let paths;
  try {
    paths = listFilesWithExt(ASSETS_DIR, '.js');
  } catch (error) {
    logError(
      `check-web-bundle-node-traces: ${ASSETS_DIR} を読めない（先に \`pnpm build\` を走らせたか）: ${error}`,
    );
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    logError(
      `check-web-bundle-node-traces: ${ASSETS_DIR} に .js が1つも無い（build が壊れていないか）`,
    );
    process.exitCode = 1;
    return;
  }

  const files = paths.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
  const hits = findNodeTraceHits(files);

  if (hits.length > 0) {
    logError(`check-web-bundle-node-traces: NG — ${hits.length}件のNode専用の痕跡が見つかった:`);
    for (const hit of hits) {
      logError(`  ${hit.path} : ${hit.pattern}`);
      logError(`    …${hit.snippet}…`);
    }
    process.exitCode = 1;
    return;
  }

  log(
    `check-web-bundle-node-traces: OK — ${files.length}ファイル / ${PATTERNS.length}パターンとも0件`,
  );
}

main();

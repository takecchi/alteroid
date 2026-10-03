#!/usr/bin/env node
/**
 * Railway のビルドで落ちる書き方（いまは `RUN --mount`）を Dockerfile から締め出す
 * （`pnpm check:dockerfile-railway`。Issue #2685）。
 *
 * **判定ロジックはここに置かない。** `check-dockerfile-railway-core.mjs` が正本で、
 * 規則の根拠・禁止していないもの・対象の決め方はあちらの doc に書いてある。
 * ここは「対象を列挙して、読んで、渡して、終了コードを決める」だけの薄い層
 * （`check-tracked-nul-bytes.mjs` と同じ分け方）。
 *
 * ## 終了コード
 *
 * | 状態 | コード |
 * |---|---|
 * | 違反なし | 0 |
 * | 違反あり | 1 |
 * | 対象を列挙できない・0件・読めない・`dockerfilePath` が壊れている | 1（fail-closed） |
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  collectTargets,
  evaluateFiles,
  formatViolations,
} from './check-dockerfile-railway-core.mjs';

const ROOT = join(import.meta.dirname, '..');

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function main() {
  const io = {
    readFile: (path) => readFileSync(join(ROOT, path), 'utf8'),
    exists: (path) => existsSync(join(ROOT, path)),
  };

  let collected;
  try {
    collected = collectTargets(ROOT, io);
  } catch (error) {
    logError(`check-dockerfile-railway: \`git ls-files\` を実行できない: ${error}`);
    process.exitCode = 1;
    return;
  }

  const { targets, problems } = collected;
  let failed = false;

  for (const problem of problems) {
    logError(`check-dockerfile-railway: ${problem.path}: ${problem.message}`);
    failed = true;
  }

  if (targets.size === 0) {
    logError(
      'check-dockerfile-railway: 対象の Dockerfile が0件（git repo の外で走らせていないか）',
    );
    process.exitCode = 1;
    return;
  }

  const files = [];
  for (const path of targets.keys()) {
    try {
      files.push({ path, content: io.readFile(path) });
    } catch (error) {
      logError(`check-dockerfile-railway: ${path} を読めない: ${error}`);
      failed = true;
    }
  }

  const violations = evaluateFiles(files);
  if (violations.length > 0) {
    logError(formatViolations(violations));
    failed = true;
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }

  // **必ず1行出す**（出ていなければ走っていないと読める）。
  log(
    `check-dockerfile-railway: OK — ${files.length}ファイルとも RUN --mount なし: ` +
      [...targets.keys()].join(', '),
  );
}

main();

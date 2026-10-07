#!/usr/bin/env node
// 使い方: pnpm check:dockerfile-railway（違反なし 0、違反あり・対象を列挙できない・0件・読めない場合は 1）

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

  log(
    `check-dockerfile-railway: OK — ${files.length}ファイルとも RUN --mount なし: ` +
      [...targets.keys()].join(', '),
  );
}

main();

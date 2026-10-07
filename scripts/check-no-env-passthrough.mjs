#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  ALLOWLIST,
  ALLOWLIST_MISSING_ENV,
  classifyEnvPassthroughHits,
  findEnvPassthroughHits,
  findMissingEnvChildProcessCalls,
  listTargetFiles,
} from './check-no-env-passthrough-core.mjs';

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
    paths = listTargetFiles(ROOT);
  } catch (error) {
    logError(`check-no-env-passthrough: \`git ls-files\` を実行できない: ${error}`);
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    logError('check-no-env-passthrough: 対象ファイルが0件（git repo の外で走らせていないか）');
    process.exitCode = 1;
    return;
  }

  const files = [];
  for (const path of paths) {
    let content;
    try {
      content = readFileSync(join(ROOT, path), 'utf8');
    } catch (error) {
      logError(`check-no-env-passthrough: ${path} を読めないため検査から外す: ${error}`);
      continue;
    }
    files.push({ path, content });
  }

  const hits = findEnvPassthroughHits(files);
  const { violations, stale } = classifyEnvPassthroughHits(hits, ALLOWLIST);

  const missingEnvHits = findMissingEnvChildProcessCalls(files);
  const { violations: missingEnvViolations, stale: missingEnvStale } = classifyEnvPassthroughHits(
    missingEnvHits,
    ALLOWLIST_MISSING_ENV,
  );

  let failed = false;

  if (violations.length > 0) {
    failed = true;
    logError(
      `check-no-env-passthrough: NG — 子プロセスへ親の env を丸ごと渡す形が` +
        `${violations.length}件見つかった:`,
    );
    for (const hit of violations) {
      logError(`  ${hit.path}:${hit.line} ${hit.describe}`);
      logError(`    ${hit.snippet}`);
    }
    logError(
      '  対策: 必要な鍵だけを明示的に組み立てる（例: scripts/git-child-env.ts の ' +
        'gitChildEnv()、scripts/mutate-cli-child-env.ts の mutateCliChildEnv()）。' +
        'わざと丸ごと渡す必要があるなら、理由付きで scripts/check-no-env-passthrough-core.mjs ' +
        'の ALLOWLIST へ載せること（Issue #1935 / #1854）。',
    );
  }

  if (stale.length > 0) {
    failed = true;
    logError(
      `check-no-env-passthrough: NG — ALLOWLIST に古い許可が${stale.length}件残っている` +
        '（直してしまって、もう当たりが無いのに一覧に残っている）:',
    );
    for (const entry of stale) {
      logError(`  ${entry.path}`);
    }
    logError(
      '  対策: scripts/check-no-env-passthrough-core.mjs の ALLOWLIST から、' +
        '当たりが無くなったエントリを消すこと。',
    );
  }

  if (missingEnvViolations.length > 0) {
    failed = true;
    logError(
      `check-no-env-passthrough: NG — env を指定していない子プロセス呼び出しが` +
        `${missingEnvViolations.length}件見つかった（親の process.env を丸ごと継ぐ。Issue #1971）:`,
    );
    for (const hit of missingEnvViolations) {
      logError(`  ${hit.path}:${hit.line} ${hit.describe}`);
      logError(`    ${hit.snippet}`);
    }
    logError(
      '  対策: 必要な鍵だけを明示的に組み立てる（例: scripts/git-child-env.ts の ' +
        'gitChildEnv()、scripts/mutate-cli-child-env.ts の mutateCliChildEnv()）。' +
        'わざと丸ごと渡す必要があるなら、理由付きで scripts/check-no-env-passthrough-core.mjs ' +
        'の ALLOWLIST_MISSING_ENV へ載せること（Issue #1971）。',
    );
  }

  if (missingEnvStale.length > 0) {
    failed = true;
    logError(
      `check-no-env-passthrough: NG — ALLOWLIST_MISSING_ENV に古い許可が` +
        `${missingEnvStale.length}件残っている（直してしまって、もう当たりが無いのに一覧に残っている）:`,
    );
    for (const entry of missingEnvStale) {
      logError(`  ${entry.path}`);
    }
    logError(
      '  対策: scripts/check-no-env-passthrough-core.mjs の ALLOWLIST_MISSING_ENV から、' +
        '当たりが無くなったエントリを消すこと。',
    );
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }

  log(
    `check-no-env-passthrough: OK — ${files.length}ファイルとも丸渡しなし・env 無し呼び出しなし` +
      `（許可済み${ALLOWLIST.length}件 + ${ALLOWLIST_MISSING_ENV.length}件は現物と一致）`,
  );
}

main();

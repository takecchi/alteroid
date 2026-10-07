#!/usr/bin/env node
// 使い方: pnpm check:required-status-checks（一致は 0、ずれ・読めなかった場合は 1）

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  compareRequiredStatusChecks,
  formatComparison,
  isBranchNotProtected,
  resolveLiveRequiredChecks,
} from './check-required-status-checks-core.mjs';

const ROOT = join(import.meta.dirname, '..');
const DECLARATION_PATH = join(ROOT, '.github', 'required-status-checks.json');
const PROTECTION_PATH = 'repos/takecchi/alteroid/branches/main/protection';
const RULES_PATH = 'repos/takecchi/alteroid/rules/branches/main';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

// `absent` は 404 `Branch not protected` のときだけ: それ以外の失敗は `error` として理由を捨てない。
function ghGet(path, { allowAbsent }) {
  try {
    const stdout = execFileSync('gh', ['api', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 'ok', body: JSON.parse(stdout) };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    if (allowAbsent && isBranchNotProtected(detail)) return { status: 'absent' };
    return { status: 'error', detail };
  }
}

function main() {
  let declared;
  try {
    const raw = JSON.parse(readFileSync(DECLARATION_PATH, 'utf8'));
    if (!Array.isArray(raw.contexts) || raw.contexts.some((n) => typeof n !== 'string')) {
      logError(
        `check-required-status-checks: ${DECLARATION_PATH} の contexts が文字列の配列でない`,
      );
      process.exitCode = 1;
      return;
    }
    declared = raw.contexts;
  } catch (error) {
    logError(`check-required-status-checks: ${DECLARATION_PATH} を読めない: ${error}`);
    process.exitCode = 1;
    return;
  }

  const protection = ghGet(PROTECTION_PATH, { allowAbsent: true });
  const rules = ghGet(RULES_PATH, { allowAbsent: false });
  const { live, reasons } = resolveLiveRequiredChecks(protection, rules);
  const result = compareRequiredStatusChecks(declared, live, reasons);

  if (result.verdict === 'match') {
    log(formatComparison(result));
    return;
  }

  logError(formatComparison(result));
  process.exitCode = 1;
}

main();

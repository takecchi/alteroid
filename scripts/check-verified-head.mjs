#!/usr/bin/env node
// 使い方: pnpm check:verified-head [-- <rev>]（<rev> の既定は HEAD。match は 0、mismatch は 1、undecidable は 2）
// `undecidable` を `match`（0）にも `mismatch`（1）にも混ぜない: 「一致」へ倒すと、緑を見た後に1行直して push した穴を見逃すため。

import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { compareVerifiedHead, formatVerdict } from './check-verified-head-core.mjs';
import { recordPathFor } from './verify-core.mjs';

const ROOT = join(import.meta.dirname, '..');

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function parseArgs(argv) {
  const positional = argv.find((a) => !a.startsWith('-'));
  return { rev: positional ?? 'HEAD' };
}

function main() {
  const { rev } = parseArgs(process.argv.slice(2));
  const recordPath = recordPathFor(ROOT);
  const result = compareVerifiedHead({ repo: ROOT, rev, recordPath });
  const text = formatVerdict(rev, result);

  if (result.verdict === 'match') {
    log(text);
    return;
  }

  logError(text);
  process.exitCode = result.verdict === 'mismatch' ? 1 : 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

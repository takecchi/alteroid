#!/usr/bin/env node
// 使い方: pnpm check:sdk-quotes
// CI の別ステップにしない: `check-sdk-quotes.test.ts` が同じ core を実物に当てており、`pnpm test` に既に載っているため。

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

import {
  collectMarkedQuotes,
  findQuoteDefects,
  listScannableFiles,
  resolveSdkTypes,
  MARKER,
} from './check-sdk-quotes-core.mjs';

const REPO_ROOT = `${import.meta.dirname}/..`;

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function main() {
  let sdk;
  try {
    sdk = resolveSdkTypes(REPO_ROOT, createRequire, existsSync, readFileSync);
  } catch (error) {
    logError(`${error.message}`);
    process.exitCode = 1;
    return;
  }

  const files = listScannableFiles(REPO_ROOT);
  const quotes = collectMarkedQuotes(files);
  const defects = findQuoteDefects(quotes, sdk.text);

  if (defects.length > 0) {
    logError(
      `check-sdk-quotes: NG — ${quotes.length}件の逐語のうち ${defects.length}件が SDK ${sdk.version} と食い違う:`,
    );
    for (const d of defects) {
      logError(`  ${d.path}:${d.line}  ${d.reason}`);
      if (d.quote) logError(`    引用: ${d.quote}`);
    }
    logError('');
    logError(`  当てた先: ${sdk.typesPath}`);
    logError(
      `  直し方: 上の引用を ${sdk.version} 同梱の sdk.d.ts の現行文言へ**1行のまま**書き直し、`,
    );
    logError('          周りの日本語の但し書き（「version X 同梱」）も一緒に直すこと。');
    logError(
      '          意図して古い版を引いている記述（新旧の対比）なら、印のほうを外すのが正しい。',
    );
    process.exitCode = 1;
    return;
  }

  log(
    `check-sdk-quotes: OK — ${files.length}ファイル中 ${quotes.length}件の ${MARKER} がすべて SDK ${sdk.version} の型定義（sdk.d.ts / sdk-tools.d.ts）に当たった`,
  );
}

main();

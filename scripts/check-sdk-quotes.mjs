#!/usr/bin/env node
/**
 * 印（`[sdk-verbatim …]`）の付いた逐語引用が、**インストール済みの `sdk.d.ts` に
 * いまも当たること**を確かめる（`pnpm check:sdk-quotes`）。
 *
 * **判定は `check-sdk-quotes-core.mjs` の doc が正本。** このファイルには置かない。
 *
 * ## CI では別ステップにしていない
 *
 * この検査は `scripts/check-sdk-quotes.test.ts` の中から**同じ core を呼んで
 * 実物に当てている**ので、`pnpm test`（＝ `pnpm verify` の `test` 手順・
 * `.github/workflows/ci.yml` の `pnpm test`）に既に載っている。
 * ワークフローを変えずに CI へ足す形は `check-web-css-comment-classnames` と同じである。
 * **この CLI は手元で1本だけ回して読むための口**であり、CI の手順を増やさない。
 */

import { execFileSync } from 'node:child_process';
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

// `console` に頼らない理由は `check-web-css-comment-classnames.mjs` と同じ。
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
    // **黙って緑にしない。**「0件だった」と「走らなかった」を混ぜない。
    logError(`${error.message}`);
    process.exitCode = 1;
    return;
  }

  const files = listScannableFiles(REPO_ROOT, execFileSync, readFileSync);
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

  // **必ず1行出す**（出ていなければ走っていないと読める）。
  log(
    `check-sdk-quotes: OK — ${files.length}ファイル中 ${quotes.length}件の ${MARKER} がすべて SDK ${sdk.version} の型定義（sdk.d.ts / sdk-tools.d.ts）に当たった`,
  );
}

main();

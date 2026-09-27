#!/usr/bin/env node
/**
 * `pnpm check:verified-head [<rev>]`（Issue #1763・#1192 の N7）。
 *
 * 判定ロジックはここに置かない。`check-verified-head-core.mjs` が正本。ここは
 * `<rev>` を読み、記録の置き場（`verify-core.mjs` の `recordPathFor`）を引き、
 * 判定を呼んで、出力して、終了コードを決めるだけの薄い層
 * （`check-required-status-checks.mjs` と同じ分け方）。**書き換えない。読むだけ**
 * ——本物の index も作業ツリーも動かさない。
 *
 * ## 使い方
 *
 *     pnpm check:verified-head              # <rev> の既定は HEAD
 *     pnpm check:verified-head -- <rev>
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: `<rev>` の tree が、直近の `pnpm verify` が全部通った
 *   ときの tree と一致するか。不一致なら、検証の後に変わったファイルの一覧。
 * - **言えないこと**: **`main` へ push した後の話には使えない。** 記録は
 *   手元の `.git/` の中にしか無く、CI からは見えない（この道具は CI の門では
 *   ない。`scripts/check-scripts-wired.test.ts` の `EXEMPT` に理由を書いてある）。
 * - **書き換えない。** 読むだけである。
 *
 * ## 終了コード
 *
 * | verdict       | コード |
 * | ------------- | ------ |
 * | `match`       | 0      |
 * | `mismatch`    | 1      |
 * | `undecidable` | 2      |
 *
 * **`undecidable` を `match`（0）にも `mismatch`（1）にも混ぜない。** 「判定
 * できない」を「一致」へ倒すと、直そうとしている当の穴（緑を見た後に1行
 * 直して push した）を見逃す側に嘘をつく（`AGENTS.md`「『判定できない』と
 * いう3つ目の状態を持つ」）。
 */

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

/** 最初の非オプション引数を `<rev>` として読む。既定は `HEAD`。 */
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

// 直接起動されたときだけ走る（`check-pr-green.mjs` と同じガード）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

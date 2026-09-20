#!/usr/bin/env node
/**
 * この PR の本文が、実在するリポジトリのファイルを `path:行番号` の形で
 * 単独の出典にしていないかを確かめる（`pnpm check:pr-line-number-citations`。
 * Issue #1192 の N3 に対応する）。
 *
 * **判定ロジックはここに置かない。** `check-pr-line-number-citations-core.mjs` が
 * 正本で、なぜこの形にしたか・弾く形／弾かない形の根拠・required にしない理由・
 * 確かめていないことは、あちらの doc に書いてある。ここはネットワーク
 * （`gh pr view`）とファイルシステム（`isRepoFile`）を持ち、結果を出力し、
 * 終了コードを決めるだけの薄い層（`check-pr-closing-keywords.mjs` /
 * `check-pr-vanished-footprint.mjs` と同じ分け方）。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: 呼ばれた時点の PR 本文に、実在するファイルを `path:行番号`
 *   の形で指す出典が在るか。
 * - **言えないこと**: それが「本物の違反」か「過去に壊れていた出典を直した経緯の
 *   説明」かの区別（`check-pr-line-number-citations-core.mjs` の doc、PR #892 の
 *   実例を見よ）。書いた側の意図は読めない——だから required にしない。
 * - **書き換えない。** 読むだけである。
 *
 * ## 入力（環境変数。手元で叩くための `--pr` / `--repo` 引数でも上書きできる）
 *
 * | 引数 | 既定の環境変数 | 意味 |
 * |---|---|---|
 * | `--pr` | `PR_LINE_NUMBER_CITATIONS_PR_NUMBER` | 検査する PR 番号 |
 * | `--repo` | `GITHUB_REPOSITORY` | `owner/repo` |
 *
 * どちらか1つでも欠けたら、**黙って緑にしない**（`check-pr-closing-keywords.mjs`
 * と同じ理由——読みに行くための情報が最初から無いのは `unreadable` とは別の
 * 失敗である）。
 *
 * ## 終了コード
 *
 * | verdict | コード |
 * |---|---|
 * | `ok` | 0 |
 * | `found` | 1 |
 * | `unreadable` | 1 |
 * | （引数不足） | 1 |
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

import {
  evaluatePrLineNumberCitations,
  formatVerdict,
} from './check-pr-line-number-citations-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

/** `--flag value` と `--flag=value` の両方を受ける（他の check:* wrapper と同じ）。 */
function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      result[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[key] = next;
      i++;
    } else {
      result[key] = '';
    }
  }
  return result;
}

/**
 * 候補文字列がこのリポジトリ相対の実在ファイルかどうか（`agents-md-references.test.ts`
 * の `isRepoFile` と同じ判断——`..` を含むものは拒否し、`statSync` で実在を見る）。
 */
function isRepoFile(candidate) {
  if (candidate.includes('..')) return false;
  try {
    return statSync(path.join(ROOT, candidate)).isFile();
  } catch {
    return false;
  }
}

function fetchPrBody(prNumber, repo) {
  try {
    const stdout = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { data: JSON.parse(stdout), error: null };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { data: null, error: detail };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const prRaw = args.pr || process.env.PR_LINE_NUMBER_CITATIONS_PR_NUMBER || '';
  const repo = args.repo || process.env.GITHUB_REPOSITORY || '';

  if (!/^\d+$/.test(prRaw) || repo === '') {
    logError(
      'check-pr-line-number-citations: 呼び方の誤り — --pr/--repo（または ' +
        'PR_LINE_NUMBER_CITATIONS_PR_NUMBER/GITHUB_REPOSITORY）が要る。' +
        'PR の文脈でのみ呼ぶこと（ワークフロー側の trigger が担保する）。',
    );
    process.exitCode = 1;
    return;
  }

  const { data, error } = fetchPrBody(prRaw, repo);

  let body = null;
  const fetchErrors = [];

  if (data === null) {
    fetchErrors.push(`gh pr view が失敗した: ${error}`);
  } else {
    // `body` が無い（空の PR 本文）ことと「取得に失敗した」ことは区別する——
    // 前者は空文字として扱い、正常に「読めた」結果にする
    // （`check-pr-closing-keywords.mjs` / `check-pr-vanished-footprint.mjs` と同じ）。
    body = typeof data.body === 'string' ? data.body : '';
  }

  const result = evaluatePrLineNumberCitations({ body }, { isRepoFile });
  const text = formatVerdict(prRaw, result);

  if (result.verdict === 'ok') {
    log(text);
    return;
  }

  logError(text);
  if (result.verdict === 'unreadable') {
    for (const detail of fetchErrors) logError(`  ${detail}`);
  }
  process.exitCode = 1;
}

main();

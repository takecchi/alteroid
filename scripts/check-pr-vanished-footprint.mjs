#!/usr/bin/env node
/**
 * この PR が途中のコミットで触ったのに最終差分から消えたファイル（「消えた
 * 足跡」）を本文が名指ししていないかを確かめる（`pnpm check:pr-vanished-footprint`。
 * Issue #1130）。
 *
 * **判定ロジックはここに置かない。** `check-pr-vanished-footprint-core.mjs` が
 * 正本で、なぜこの形にしたか・動詞判定を入れない理由・required にしない理由・
 * この門が拾えない族は、あちらの doc に書いてある。ここはネットワーク
 * （`gh api` / `gh pr view`）を持ち、結果を出力し、終了コードを決めるだけの
 * 薄い層（`check-no-attribution-trailers.mjs` / `check-pr-closing-keywords.mjs`
 * と同じ分け方）。
 *
 * ## 何を取得するか
 *
 * - `U`（各コミットが触ったファイルの和集合）: `gh api
 *   repos/<repo>/pulls/<N>/commits --paginate --jq '.[].sha'` で sha 一覧を取り、
 *   各 sha ごとに `gh api repos/<repo>/commits/<sha>` を叩いて `.parents` の件数
 *   （2件以上ならマージコミットとして `U` から除外）と `.files[].filename` を読む。
 * - `F`（最終差分）: `gh api repos/<repo>/pulls/<N>/files --paginate --jq
 *   '.[].filename'`。**`gh pr diff <N> --name-only` ではなくこちらを使った**
 *   ——`U` の取得と同じ `gh api` の形に揃えるためで、`gh pr diff` を避ける積極的な
 *   理由があるわけではない（`check-pr-vanished-footprint-core.mjs` の doc に同じ
 *   注記がある）。
 * - 本文: `gh pr view <N> --json body`。
 *
 * ## fail-closed
 *
 * 上のどれか1つでも取得に失敗したら、そのまま `unreadable`（赤・終了コード1）に
 * 倒す。**部分的に取れた分だけで判定しない**——コミットの一部が読めなかった状態で
 * `U` を計算すると、実際より小さい `V` を報告して見逃す側へ倒れるため。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: 呼ばれた時点で、この PR が触って消したファイルのうち、本文が
 *   まだ名指ししているものがあるか。
 * - **言えないこと**: 本文の主張が嘘かどうか（`core` の doc の「⛔ 赤のときに何と
 *   言うか」を見よ）。一度も触っていないファイルについての虚偽（この門が拾えない
 *   族）。
 * - **書き換えない。** 読むだけである。
 *
 * ## 入力（環境変数。手元で叩くための `--pr` / `--repo` 引数でも上書きできる）
 *
 * | 引数 | 既定の環境変数 | 意味 |
 * |---|---|---|
 * | `--pr` | `PR_VANISHED_FOOTPRINT_PR_NUMBER` | 検査する PR 番号 |
 * | `--repo` | `GITHUB_REPOSITORY` | `owner/repo` |
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
import process from 'node:process';

import { evaluatePrVanishedFootprint, formatVerdict } from './check-pr-vanished-footprint-core.mjs';

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

function runGh(args) {
  try {
    const stdout = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, error: null };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { stdout: null, error: detail };
  }
}

/** 改行区切りの出力を、空行を除いた配列にする。 */
function splitNonEmptyLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * `U` を計算するための入力を取る。commits の1本でも読めなければ `null`
 * （fail-closed。「読めた分だけで判定する」を避ける）。
 */
function fetchCommits(prNumber, repo, errors) {
  const shaResult = runGh([
    'api',
    `repos/${repo}/pulls/${prNumber}/commits`,
    '--paginate',
    '--jq',
    '.[].sha',
  ]);
  if (shaResult.stdout === null) {
    errors.push(`コミット一覧の取得に失敗した: ${shaResult.error}`);
    return null;
  }
  const shas = splitNonEmptyLines(shaResult.stdout);

  const commits = [];
  for (const sha of shas) {
    const commitResult = runGh(['api', `repos/${repo}/commits/${sha}`]);
    if (commitResult.stdout === null) {
      errors.push(`commit ${sha} の取得に失敗した: ${commitResult.error}`);
      return null;
    }
    let data;
    try {
      data = JSON.parse(commitResult.stdout);
    } catch (parseError) {
      errors.push(`commit ${sha} の応答を JSON として読めなかった: ${String(parseError)}`);
      return null;
    }
    const parentCount = Array.isArray(data.parents) ? data.parents.length : 0;
    const files = Array.isArray(data.files)
      ? data.files
          .map((f) => (f && typeof f.filename === 'string' ? f.filename : null))
          .filter((f) => f !== null)
      : [];
    commits.push({ sha, parentCount, files });
  }
  return commits;
}

function fetchFinalFiles(prNumber, repo, errors) {
  const result = runGh([
    'api',
    `repos/${repo}/pulls/${prNumber}/files`,
    '--paginate',
    '--jq',
    '.[].filename',
  ]);
  if (result.stdout === null) {
    errors.push(`最終差分（files）の取得に失敗した: ${result.error}`);
    return null;
  }
  return splitNonEmptyLines(result.stdout);
}

function fetchBody(prNumber, repo, errors) {
  const result = runGh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body']);
  if (result.stdout === null) {
    errors.push(`PR 本文の取得に失敗した: ${result.error}`);
    return null;
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (parseError) {
    errors.push(`gh pr view の応答を JSON として読めなかった: ${String(parseError)}`);
    return null;
  }
  return typeof data.body === 'string' ? data.body : '';
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const prRaw = args.pr || process.env.PR_VANISHED_FOOTPRINT_PR_NUMBER || '';
  const repo = args.repo || process.env.GITHUB_REPOSITORY || '';

  if (!/^\d+$/.test(prRaw) || repo === '') {
    logError(
      'check-pr-vanished-footprint: 呼び方の誤り — --pr/--repo（または ' +
        'PR_VANISHED_FOOTPRINT_PR_NUMBER/GITHUB_REPOSITORY）が要る。' +
        'PR の文脈でのみ呼ぶこと（ワークフロー側の trigger が担保する）。',
    );
    process.exitCode = 1;
    return;
  }

  const errors = [];
  const commits = fetchCommits(prRaw, repo, errors);
  const finalFiles = fetchFinalFiles(prRaw, repo, errors);
  const body = fetchBody(prRaw, repo, errors);

  const result = evaluatePrVanishedFootprint({ commits, finalFiles, body });
  const text = formatVerdict(prRaw, result);

  if (result.verdict === 'ok') {
    log(text);
    return;
  }

  logError(text);
  if (result.verdict === 'unreadable') {
    for (const detail of errors) logError(`  ${detail}`);
  }
  process.exitCode = 1;
}

main();

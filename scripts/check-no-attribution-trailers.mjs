#!/usr/bin/env node
// 使い方: pnpm check:no-attribution-trailers [--pr N] [--repo owner/repo]（環境変数 NO_ATTRIBUTION_TRAILERS_PR_NUMBER / GITHUB_REPOSITORY。clean は 0、それ以外は 1）
// 引数が欠けたら `unreadable` ではなく呼び方の誤りとして 1 を返す: 緑にしないため。

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import {
  commitFullMessage,
  evaluateNoAttributionTrailers,
  formatVerdict,
} from './check-no-attribution-trailers-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

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

// 本文とコミットを1回で取る: 2回に分けると本文を落とす罠を踏むため。
function fetchPr(prNumber, repo) {
  try {
    const stdout = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body,commits'],
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

  const prRaw = args.pr || process.env.NO_ATTRIBUTION_TRAILERS_PR_NUMBER || '';
  const repo = args.repo || process.env.GITHUB_REPOSITORY || '';

  if (!/^\d+$/.test(prRaw) || repo === '') {
    logError(
      'check-no-attribution-trailers: 呼び方の誤り — --pr/--repo（または ' +
        'NO_ATTRIBUTION_TRAILERS_PR_NUMBER/GITHUB_REPOSITORY）が要る。' +
        'PR の文脈でのみ呼ぶこと（ワークフロー側の if: が担保する）。',
    );
    process.exitCode = 1;
    return;
  }

  const { data, error } = fetchPr(prRaw, repo);

  let body = null;
  let commits = null;
  const fetchErrors = [];

  if (data === null) {
    fetchErrors.push(`gh pr view が失敗した: ${error}`);
  } else {
    body = typeof data.body === 'string' ? data.body : '';

    if (Array.isArray(data.commits)) {
      commits = data.commits.map((c) => ({
        oid: typeof c?.oid === 'string' ? c.oid : null,
        headline: typeof c?.messageHeadline === 'string' ? c.messageHeadline : '',
        message: commitFullMessage(c?.messageHeadline, c?.messageBody),
      }));
    } else {
      fetchErrors.push('gh pr view の応答に commits 配列が無い（応答の形が想定と違う）');
    }
  }

  const result = evaluateNoAttributionTrailers({ body, commits });
  const text = formatVerdict(prRaw, result);

  if (result.verdict === 'clean') {
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

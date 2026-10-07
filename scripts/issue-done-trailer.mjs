#!/usr/bin/env node
// 使い方: node ./scripts/issue-done-trailer.mjs [--pr N] [--repo owner/repo] [--apply]（環境変数 ISSUE_DONE_TRAILER_PR_NUMBER / GITHUB_REPOSITORY / ISSUE_DONE_TRAILER_APPLY）
// 既定は dry-run: `--apply`（または `ISSUE_DONE_TRAILER_APPLY=1`）が無い限り `gh issue close` を呼ばず、手元で誤って叩いても何も閉じないため。
// 読む場所は PR 本文だけに固定する: 実際に Issue を閉じる操作なので、どの記述が根拠だったかを一意に追えるようにするため。
// `pull_request_target` を採らない: 安全でないため。

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import { evaluateIssueDoneTrailer, formatEvaluation } from './issue-done-trailer-core.mjs';

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

function isApplyRequested(args) {
  if ('apply' in args) return true;
  const envValue = process.env.ISSUE_DONE_TRAILER_APPLY;
  return envValue === '1' || envValue === 'true';
}

function fetchPr(prNumber, repo) {
  try {
    const stdout = execFileSync(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        repo,
        '--json',
        'number,body,mergedAt,mergeCommit,baseRefName',
      ],
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

// PR 番号をここで弾く: GitHub は PR も「issue」として返す（`pull_request` キーの有無で区別する）ため。
function fetchIssue(issueNumber, repo) {
  try {
    const stdout = execFileSync('gh', ['api', `repos/${repo}/issues/${issueNumber}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { data: JSON.parse(stdout), error: null };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { data: null, error: detail };
  }
}

function closeIssue(issueNumber, repo, comment) {
  try {
    execFileSync(
      'gh',
      ['issue', 'close', String(issueNumber), '--repo', repo, '--comment', comment],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, error: null };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { ok: false, error: detail };
  }
}

function buildCloseComment({ prNumber, mergedAt, sourceLine }) {
  return [
    `Alteroid-Issue-Done trailer により、PR #${prNumber} のマージ（${mergedAt}）を受けて自動で close した。`,
    '',
    '読んだ trailer 行（逐語）:',
    '',
    '```',
    sourceLine,
    '```',
  ].join('\n');
}

function processIssue(issue, { repo, prNumber, mergedAt, apply }) {
  const { number, sourceLine } = issue;

  const { data, error } = fetchIssue(number, repo);
  if (data === null) {
    return { number, action: 'error', detail: `gh api で Issue を読めなかった: ${error}` };
  }

  if (typeof data.pull_request === 'object' && data.pull_request !== null) {
    return {
      number,
      action: 'skipped-not-issue',
      detail: `#${number} は Issue ではなく PR である。trailer の値を見直すこと`,
    };
  }

  const state = typeof data.state === 'string' ? data.state.toUpperCase() : null;
  if (state !== 'OPEN') {
    return {
      number,
      action: 'skipped-not-open',
      detail: `#${number} は既に ${state ?? '(state不明)'} である。閉じる必要が無い`,
    };
  }

  if (!apply) {
    return {
      number,
      action: 'would-close',
      detail: `#${number} は OPEN。--apply が無いので閉じない（dry-run）`,
    };
  }

  const comment = buildCloseComment({ prNumber, mergedAt, sourceLine });
  const { ok, error: closeError } = closeIssue(number, repo, comment);
  if (!ok) {
    return { number, action: 'error', detail: `gh issue close が失敗した: ${closeError}` };
  }
  return { number, action: 'closed', detail: `#${number} を close した（根拠コメント付き）` };
}

function describeDecision(prNumber, mergedAt, outcome, sourceLine) {
  return (
    `issue-done-trailer(#${prNumber}, merged ${mergedAt}): ` +
    `trailer行="${sourceLine}" -> #${outcome.number} [${outcome.action}] ${outcome.detail}`
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const prRaw = args.pr || process.env.ISSUE_DONE_TRAILER_PR_NUMBER || '';
  const repo = args.repo || process.env.GITHUB_REPOSITORY || '';
  const apply = isApplyRequested(args);

  if (!/^\d+$/.test(prRaw) || repo === '') {
    logError(
      'issue-done-trailer: 呼び方の誤り — --pr/--repo（または ' +
        'ISSUE_DONE_TRAILER_PR_NUMBER/GITHUB_REPOSITORY）が要る。' +
        'マージ済み PR の文脈でのみ呼ぶこと（ワークフロー側の trigger が担保する）。',
    );
    process.exitCode = 1;
    return;
  }

  log(
    apply
      ? '=== APPLY モード: 実際に close する ==='
      : '=== DRY RUN（既定）: 実際には close しない ===',
  );

  const { data, error } = fetchPr(prRaw, repo);
  if (data === null) {
    logError(`issue-done-trailer(#${prRaw}): gh pr view が失敗した: ${error}`);
    process.exitCode = 1;
    return;
  }

  if (typeof data.mergedAt !== 'string' || data.mergedAt === null) {
    logError(
      `issue-done-trailer(#${prRaw}): この PR はマージされていない（mergedAt が無い）。` +
        'この道具はマージ後にのみ呼ぶこと。',
    );
    process.exitCode = 1;
    return;
  }

  const body = typeof data.body === 'string' ? data.body : '';
  const mergedAt = data.mergedAt;
  const baseRefName = typeof data.baseRefName === 'string' ? data.baseRefName : '(不明)';

  log(`PR #${prRaw} / base=${baseRefName} / mergedAt=${mergedAt}`);

  const result = evaluateIssueDoneTrailer(body);
  log(formatEvaluation(result));

  if (result.verdict !== 'close') {
    return;
  }

  let hadError = false;
  for (const issue of result.issues) {
    const outcome = processIssue(issue, { repo, prNumber: prRaw, mergedAt, apply });
    log(describeDecision(prRaw, mergedAt, outcome, issue.sourceLine));
    if (outcome.action === 'error') hadError = true;
  }

  if (hadError) {
    process.exitCode = 1;
  }
}

main();

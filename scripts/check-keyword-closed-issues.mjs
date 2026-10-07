#!/usr/bin/env node
// 使い方: node ./scripts/check-keyword-closed-issues.mjs [--repo owner/repo] [--threshold N]
// 候補があっても失敗にしない: 門ではないので「見つかった」ことは異常ではない。

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import {
  DEFAULT_THRESHOLD_SECONDS,
  findKeywordClosedCandidates,
  formatReport,
} from './check-keyword-closed-issues-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function parseArgs(argv) {
  let repo = 'takecchi/alteroid';
  let threshold = DEFAULT_THRESHOLD_SECONDS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      repo = argv[++i];
    } else if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length);
    } else if (arg === '--threshold') {
      threshold = Number(argv[++i]);
    } else if (arg.startsWith('--threshold=')) {
      threshold = Number(arg.slice('--threshold='.length));
    }
  }
  return { repo, threshold };
}

function ghRun(args) {
  try {
    const stdout = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
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

// `--limit` に明示的に大きい値を渡す: 渡さないと静かに取りこぼすため。
// コミットメッセージを取らない: squash マージのみなので実質 PR 本文と同じで、PR の数だけ API を叩く費用に見合わないため。
function fetchMergedPRs(repo) {
  const { stdout, error } = ghRun([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'merged',
    '--limit',
    '1000',
    '--json',
    'number,mergedAt,mergeCommit,body',
  ]);
  if (stdout === null) return { data: null, error };
  const parsed = JSON.parse(stdout);
  return {
    data: parsed
      .filter((p) => typeof p.mergedAt === 'string')
      .map((p) => ({
        number: p.number,
        mergedAt: p.mergedAt,
        mergeCommitOid: typeof p.mergeCommit?.oid === 'string' ? p.mergeCommit.oid : null,
        body: typeof p.body === 'string' ? p.body : '',
      })),
    error: null,
  };
}

// `gh issue list --state closed` ではなく `/repos/<repo>/issues/events` を使う: 前者は reopen された分の過去の close イベントを取りこぼすため。
// `--paginate` と `--slurp` を併用しない: `--jq` と併用できないため。
function fetchIssueCloseEvents(repo) {
  const { stdout, error } = ghRun([
    'api',
    `repos/${repo}/issues/events`,
    '--paginate',
    '--jq',
    '.[] | select(.event=="closed") | {number: .issue.number, is_pr: (.issue.pull_request != null), created_at, commit_id, actor: .actor.login}',
  ]);
  if (stdout === null) return { data: null, error };

  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const data = [];
  for (const line of lines) {
    const ev = JSON.parse(line);
    if (ev.is_pr) continue;
    data.push({
      issueNumber: ev.number,
      closedAt: ev.created_at,
      commitId: typeof ev.commit_id === 'string' && ev.commit_id.length > 0 ? ev.commit_id : null,
      actor: typeof ev.actor === 'string' ? ev.actor : null,
    });
  }
  return { data, error: null };
}

function main() {
  const { repo, threshold } = parseArgs(process.argv.slice(2));

  if (!Number.isFinite(threshold) || threshold < 0) {
    logError(
      `check-keyword-closed-issues: --threshold は0以上の数でなければならない: ${threshold}`,
    );
    process.exitCode = 1;
    return;
  }

  const { data: mergedPRs, error: prError } = fetchMergedPRs(repo);
  if (mergedPRs === null) {
    logError('check-keyword-closed-issues: 判定できなかった —— マージ済み PR の一覧を読めない');
    logError(`  gh の出力: ${prError}`);
    process.exitCode = 1;
    return;
  }

  const { data: closeEvents, error: eventsError } = fetchIssueCloseEvents(repo);
  if (closeEvents === null) {
    logError(
      'check-keyword-closed-issues: 判定できなかった —— Issue の closed イベント一覧を読めない',
    );
    logError(`  gh の出力: ${eventsError}`);
    process.exitCode = 1;
    return;
  }

  const candidates = findKeywordClosedCandidates({
    mergedPRs,
    closeEvents,
    thresholdSeconds: threshold,
  });
  log(formatReport(candidates, threshold));
}

main();

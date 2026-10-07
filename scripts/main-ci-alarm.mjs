#!/usr/bin/env node
// 使い方: pnpm main-ci-alarm [--repo ... --workflow ... --sha ... --run-id ... --run-url ... --conclusion ... --head-branch ... --default-branch ... --run-attempt N] [--apply]（各引数は `MAIN_CI_ALARM_*` 環境変数でも渡せる。欠けていれば終了コード 1）
// 既定は dry-run: `--apply`（または `MAIN_CI_ALARM_APPLY=1`）が無い限り `gh issue create` / `gh issue comment` を呼ばず、手元で誤って叩いても Issue が生えないため。
// 警報の警報は置かない: ここは意図的に1段で止める。

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import {
  alarmKey,
  alarmMarker,
  buildCommentBody,
  buildIssueBody,
  buildIssueTitle,
  decideAlarmAction,
  CANCEL_AWARE_WORKFLOW_NAME,
  findOpenAlarmIssue,
  shouldAlarm,
} from './main-ci-alarm-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      out.apply = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) {
        out[arg.slice(2)] = argv[++i];
      } else {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    }
  }
  return out;
}

function isApplyRequested(args) {
  if (args.apply === true) return true;
  const envValue = process.env.MAIN_CI_ALARM_APPLY;
  return envValue === '1' || envValue === 'true';
}

function gh(argv, { input } = {}) {
  try {
    const stdout = execFileSync('gh', argv, {
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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

// `gh search` を使わない: 検索インデックスの反映が遅れ、立てた直後の Issue が見つからないと同じ鍵で2本目が生えるため。
function fetchOpenIssues(repo) {
  const { stdout, error } = gh([
    'api',
    '--paginate',
    `repos/${repo}/issues?state=open&per_page=100`,
  ]);
  if (stdout === null) return { issues: null, error };
  try {
    const parsed = JSON.parse(stdout);
    return { issues: Array.isArray(parsed) ? parsed : [], error: null };
  } catch (e) {
    return { issues: null, error: `応答を JSON として読めなかった: ${String(e)}` };
  }
}

function fetchIssueComments(repo, issueNumber) {
  const { stdout, error } = gh([
    'api',
    '--paginate',
    `repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
  ]);
  if (stdout === null) return { comments: null, error };
  try {
    const parsed = JSON.parse(stdout);
    return { comments: Array.isArray(parsed) ? parsed : [], error: null };
  } catch (e) {
    return { comments: null, error: `応答を JSON として読めなかった: ${String(e)}` };
  }
}

// `--jq` で1件1行にして読む: `--paginate` は `.jobs` を持つ応答を1つの JSON へ連結できないため。
function fetchRunJobs(repo, runId, runAttempt) {
  const base =
    runAttempt === ''
      ? `repos/${repo}/actions/runs/${runId}/jobs`
      : `repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs`;
  const { stdout, error } = gh([
    'api',
    '--paginate',
    `${base}?per_page=100`,
    '--jq',
    '.jobs[] | {name, conclusion}',
  ]);
  if (stdout === null) return { jobs: null, error };
  try {
    const jobs = stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
    return { jobs, error: null };
  } catch (e) {
    return { jobs: null, error: `応答を JSON として読めなかった: ${String(e)}` };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;

  const repo = args.repo || env.GITHUB_REPOSITORY || '';
  const workflowName = args.workflow || env.MAIN_CI_ALARM_WORKFLOW_NAME || '';
  const headSha = args.sha || env.MAIN_CI_ALARM_HEAD_SHA || '';
  const runId = args['run-id'] || env.MAIN_CI_ALARM_RUN_ID || '';
  const runUrl = args['run-url'] || env.MAIN_CI_ALARM_RUN_URL || '';
  const conclusion = args.conclusion || env.MAIN_CI_ALARM_CONCLUSION || '';
  const headBranch = args['head-branch'] || env.MAIN_CI_ALARM_HEAD_BRANCH || '';
  const defaultBranch = args['default-branch'] || env.MAIN_CI_ALARM_DEFAULT_BRANCH || '';

  const runAttempt = args['run-attempt'] || env.MAIN_CI_ALARM_RUN_ATTEMPT || '';

  const missing = Object.entries({
    repo,
    workflow: workflowName,
    sha: headSha,
    'run-id': runId,
    'run-url': runUrl,
    conclusion,
    'head-branch': headBranch,
    'default-branch': defaultBranch,
  })
    .filter(([, value]) => value === '')
    .map(([name]) => name);
  if (missing.length > 0) {
    logError(`main-ci-alarm: 呼び方の誤り —— 次の入力が無い: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const apply = isApplyRequested(args);
  log(apply ? '=== APPLY モード: 実際に Issue へ書く ===' : '=== dry-run: 何も書かない ===');

  let verdict = shouldAlarm({ conclusion, headBranch, defaultBranch, workflowName });
  if (verdict.alarm && workflowName === CANCEL_AWARE_WORKFLOW_NAME) {
    const { jobs, error: jobsError } = fetchRunJobs(repo, runId, runAttempt);
    if (jobs === null) {
      // jobs が読めないときは取り消しとみなさず鳴らす: 黙って消さないため。
      logError(
        'main-ci-alarm: run の jobs を読めなかった —— 取り消しかどうか判定できないので鳴らす',
      );
      logError(`  gh の出力: ${jobsError}`);
    } else {
      log(`main-ci-alarm: jobs ${jobs.map((j) => `${j.name}=${j.conclusion}`).join(', ')}`);
    }
    verdict = shouldAlarm({ conclusion, headBranch, defaultBranch, workflowName, jobs });
  }
  if (!verdict.alarm) {
    log(`main-ci-alarm: 警報を出さない —— ${verdict.reason}`);
    return;
  }
  log(`main-ci-alarm: 警報を出す —— ${verdict.reason}`);

  const key = alarmKey(workflowName, headSha);
  const marker = alarmMarker(key);

  const { issues, error: issuesError } = fetchOpenIssues(repo);
  if (issues === null) {
    logError('main-ci-alarm: open な Issue の一覧を読めなかった');
    logError(`  gh の出力: ${issuesError}`);
    process.exitCode = 1;
    return;
  }

  const existing = findOpenAlarmIssue(issues, marker);
  let commentBodies = [];
  if (existing !== null) {
    const { comments, error: commentsError } = fetchIssueComments(repo, existing.number);
    if (comments === null) {
      logError(`main-ci-alarm: #${existing.number} のコメントを読めなかった`);
      logError(`  gh の出力: ${commentsError}`);
      process.exitCode = 1;
      return;
    }
    commentBodies = comments.map((c) => c.body ?? '');
  }

  const action = decideAlarmAction({ issue: existing, commentBodies, runId });
  log(`main-ci-alarm: 鍵 ${key} ⟹ ${action.kind}（${action.reason}）`);

  if (action.kind === 'skip') return;

  if (action.kind === 'create') {
    const title = buildIssueTitle({ workflowName, headSha });
    const body = buildIssueBody({ workflowName, headSha, runId, runUrl, key });
    if (!apply) {
      log(`  立てる Issue のタイトル: ${title}`);
      log('  --- 本文 ---');
      log(body);
      return;
    }
    const { stdout, error } = gh(
      ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'],
      { input: body },
    );
    if (stdout === null) {
      logError('main-ci-alarm: gh issue create が失敗した');
      logError(`  gh の出力: ${error}`);
      process.exitCode = 1;
      return;
    }
    log(`main-ci-alarm: 立てた ${stdout.trim()}`);
    return;
  }

  const comment = buildCommentBody({ workflowName, headSha, runId, runUrl });
  if (!apply) {
    log(`  #${action.issueNumber} へ足すコメント:`);
    log(comment);
    return;
  }
  const { stdout, error } = gh(
    ['issue', 'comment', String(action.issueNumber), '--repo', repo, '--body-file', '-'],
    { input: comment },
  );
  if (stdout === null) {
    logError(`main-ci-alarm: gh issue comment が失敗した（#${action.issueNumber}）`);
    logError(`  gh の出力: ${error}`);
    process.exitCode = 1;
    return;
  }
  log(`main-ci-alarm: 足した ${stdout.trim()}`);
}

main();

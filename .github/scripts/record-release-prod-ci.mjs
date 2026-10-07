#!/usr/bin/env node
// 常に 0 で終わり、`process.exitCode` をどの経路でも立てない: 記録の失敗や赤が反映の成否に影響してはならないため。ただし黙って成功したふりはせず、失敗は必ず1行で名乗る。
// 既定は dry-run: 環境変数 `RECORD_RELEASE_PROD_CI_APPLY=1` のときだけ `gh issue comment` を呼ぶ。新しい Issue はどちらのモードでも立てない。
// 判定には `events: ['push']` を渡す: 絞らないと、この記録 step 自身が走っている `release-prod.yml` の run が判定対象に混ざり、未完了の run があると `pending` を返す `evaluatePrGreen` が毎晩自分自身を理由に `pending` を返し続けるため。

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

import { judgeSha } from '../../scripts/check-pr-green.mjs';
import { formatVerdict } from '../../scripts/check-pr-green-core.mjs';
import {
  alarmKey,
  alarmMarker,
  findOpenAlarmIssue,
  runAlreadyMentioned,
  runMention,
} from '../../scripts/main-ci-alarm-core.mjs';
import {
  buildRecordComment,
  buildRecordLine,
  describeVerdict,
  redWorkflowNames,
  refineVerdictForCancelledRuns,
} from './record-release-prod-ci-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logStepSummary(text) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, text + '\n');
  } catch (error) {
    log(`record-release-prod-ci: GITHUB_STEP_SUMMARY へ書けなかった —— ${String(error)}`);
  }
}

function emitRecordLine(fields) {
  const line = buildRecordLine(fields);
  log(line);
  logStepSummary(line);
  return line;
}

function gitRevParseHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (error) {
    return { error: String(error) };
  }
}

function lsRemoteProdSha() {
  try {
    const out = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/release/prod'], {
      encoding: 'utf8',
    });
    const sha = out.split('\t')[0]?.trim() ?? '';
    return sha;
  } catch (error) {
    return { error: String(error) };
  }
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

function isApplyRequested() {
  const v = process.env.RECORD_RELEASE_PROD_CI_APPLY;
  return v === '1' || v === 'true';
}

function recordRedToAlarmIssue({
  repo,
  prodSha,
  mainSha,
  verdict,
  reflectOutcome,
  observedAt,
  judged,
}) {
  const names = redWorkflowNames(judged.latestRuns);
  if (names.length === 0) {
    log(
      'record-release-prod-ci: verdict=red だが、赤い workflow 名を latestRuns から特定できなかった —— コメントを付けられない',
    );
    return;
  }

  const apply = isApplyRequested();
  log(apply ? '=== APPLY モード: 実際に Issue へ書く ===' : '=== dry-run: 何も書かない ===');

  const runId = process.env.GITHUB_RUN_ID || '';
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const runUrl = runId ? `${serverUrl}/${repo}/actions/runs/${runId}` : '(unknown run)';

  let wroteAny = false;
  for (const workflowName of names) {
    const key = alarmKey(workflowName, prodSha);
    const marker = alarmMarker(key);

    const { issues, error: issuesError } = fetchOpenIssues(repo);
    if (issues === null) {
      log(
        `record-release-prod-ci: open な Issue の一覧を読めなかった（鍵 ${key}）—— ${issuesError}`,
      );
      continue;
    }

    const existing = findOpenAlarmIssue(issues, marker);
    if (existing === null) {
      log(
        `record-release-prod-ci: 鍵 ${key} の警報 Issue が open で見つからない —— durable な記録を付けられなかった`,
      );
      continue;
    }

    const { comments, error: commentsError } = fetchIssueComments(repo, existing.number);
    if (comments === null) {
      log(
        `record-release-prod-ci: #${existing.number} のコメントを読めなかった —— ${commentsError}`,
      );
      continue;
    }

    const texts = [existing.body ?? '', ...comments.map((c) => c.body ?? '')];
    if (runId !== '' && runAlreadyMentioned(texts, runId)) {
      log(
        `record-release-prod-ci: #${existing.number} に ${runMention(runId)} が既に書かれている —— 足さない`,
      );
      wroteAny = true;
      continue;
    }

    const body = buildRecordComment({
      sha: prodSha,
      runId: runId || '(unknown)',
      runUrl,
      verdict,
      redWorkflows: names,
      mainSha,
      reflectOutcome,
      observedAt,
    });

    if (!apply) {
      log(`record-release-prod-ci: [dry-run] #${existing.number} へ足すコメント:`);
      log(body);
      wroteAny = true;
      continue;
    }

    const { stdout, error } = gh(
      ['issue', 'comment', String(existing.number), '--repo', repo, '--body-file', '-'],
      { input: body },
    );
    if (stdout === null) {
      log(`record-release-prod-ci: #${existing.number} へのコメントに失敗した —— ${error}`);
      continue;
    }
    log(`record-release-prod-ci: #${existing.number} へ足した ${stdout.trim()}`);
    wroteAny = true;
  }

  if (!wroteAny) {
    log('record-release-prod-ci: durable な記録を付けられなかった');
  }
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY || 'takecchi/alteroid';
  const reflectOutcome = process.env.RECORD_REFLECT_OUTCOME || '(unknown)';
  const observedAt = new Date().toISOString();

  const mainSha = gitRevParseHead();
  if (typeof mainSha !== 'string') {
    log(
      `record-release-prod-ci: main_sha を取得できなかった（git rev-parse HEAD 失敗）—— ${mainSha.error}`,
    );
    emitRecordLine({
      verdict: 'unknown',
      prodSha: '(unknown)',
      mainSha: '(unknown)',
      reflectOutcome,
      observedAt,
    });
    return;
  }

  const prodShaInput = process.env.RECORD_RELEASE_PROD_CI_SHA || lsRemoteProdSha();
  if (typeof prodShaInput !== 'string') {
    log(
      `record-release-prod-ci: prod_sha を取得できなかった（git ls-remote 失敗）—— ${prodShaInput.error}`,
    );
    emitRecordLine({
      verdict: 'unknown',
      prodSha: '(unknown)',
      mainSha,
      reflectOutcome,
      observedAt,
    });
    return;
  }
  if (prodShaInput === '') {
    log('record-release-prod-ci: prod_sha が空 —— release/prod がまだ無い（初回反映前）');
    emitRecordLine({ verdict: 'unknown', prodSha: '(none)', mainSha, reflectOutcome, observedAt });
    return;
  }
  const prodSha = prodShaInput;

  const judged = judgeSha({ sha: prodSha, repo, events: ['push'] });
  if (judged.result === null) {
    log(`record-release-prod-ci: 判定できなかった —— ${judged.error}`);
    emitRecordLine({ verdict: 'unknown', prodSha, mainSha, reflectOutcome, observedAt });
    return;
  }

  const verdict = refineVerdictForCancelledRuns({
    verdict: judged.result.verdict,
    latestRuns: judged.latestRuns,
    jobsByRunId: judged.jobsByRunId,
  });
  emitRecordLine({ verdict, prodSha, mainSha, reflectOutcome, observedAt });
  log(formatVerdict(prodSha, judged.result));
  log(`record-release-prod-ci: ${describeVerdict(verdict)}`);

  if (verdict !== 'red') return;

  recordRedToAlarmIssue({ repo, prodSha, mainSha, verdict, reflectOutcome, observedAt, judged });
}

try {
  main();
} catch (error) {
  log(`record-release-prod-ci: 予期しない例外で終わった —— ${String(error)}`);
}

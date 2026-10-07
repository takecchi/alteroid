#!/usr/bin/env node
// 使い方: node ./scripts/check-pr-green.mjs <sha> [--repo owner/repo]（green は 0、out-of-scope は 2、それ以外は 1）
// `out-of-scope` を 1 に丸めず 2 にする: 呼び出し側が「1 = 壊れている」と早合点するため。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  evaluatePrGreen,
  filterRunsByEvent,
  findMissingRequiredGates,
  formatMissingRequiredGates,
  formatVerdict,
  isFullCommitSha,
  pickLatestRunPerWorkflow,
} from './check-pr-green-core.mjs';

const DECLARATION_PATH = join(import.meta.dirname, '..', '.github', 'required-status-checks.json');

const DEFAULT_REPO = 'takecchi/alteroid';

function loadRequiredContexts() {
  try {
    const raw = JSON.parse(readFileSync(DECLARATION_PATH, 'utf8'));
    if (!Array.isArray(raw.contexts) || raw.contexts.some((name) => typeof name !== 'string')) {
      return {
        contexts: null,
        error: `${DECLARATION_PATH} の contexts が文字列の配列でない`,
      };
    }
    return { contexts: raw.contexts, error: null };
  } catch (error) {
    return { contexts: null, error: `${DECLARATION_PATH} を読めない: ${String(error)}` };
  }
}

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function parseArgs(argv) {
  let sha = null;
  let repo = DEFAULT_REPO;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      repo = argv[++i];
    } else if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length);
    } else if (!arg.startsWith('-') && sha === null) {
      sha = arg;
    }
  }
  return { sha, repo };
}

function ghApiJson(path) {
  try {
    const stdout = execFileSync('gh', ['api', path], {
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

export function judgeSha({ sha, repo, events }) {
  // 略記の sha はここで拒む: `actions/runs?head_sha=` はエラーではなく空の一覧を返し、赤いコミットが「run が無い」に化けるため。
  if (!isFullCommitSha(sha)) {
    return {
      result: null,
      latestRuns: [],
      jobsByRunId: {},
      missingRequiredGates: null,
      error:
        `完全な40文字のコミット sha を渡すこと（受け取った値: ${String(sha)}）。` +
        '略記を渡すと actions/runs は空の一覧を返し、run が1つも無いのか、' +
        '引けない sha だったのかを区別できない。',
    };
  }

  const runsPath = `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`;
  const { data: runsData, error: runsError } = ghApiJson(runsPath);
  if (runsData === null) {
    return {
      result: null,
      latestRuns: [],
      jobsByRunId: {},
      missingRequiredGates: null,
      error: `run 一覧を読めない\n  gh の出力: ${runsError}`,
    };
  }

  const runs = Array.isArray(runsData.workflow_runs) ? runsData.workflow_runs : [];
  const scopedRuns = filterRunsByEvent(runs, events);

  // jobs の問い合わせは世代選びの前に completed な scopedRuns 全件へ行う: 選ばれなかった run の jobs が無いと「1本も走っていない」か分からないため。
  const jobsByRunId = {};
  for (const run of scopedRuns) {
    if (run.status !== 'completed') continue;
    const { data: jobsData, error: jobsError } = ghApiJson(
      `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
    );
    if (jobsData === null) {
      return {
        result: null,
        latestRuns: [],
        jobsByRunId,
        missingRequiredGates: null,
        error: `run ${run.id} の jobs を読めない\n  gh の出力: ${jobsError}`,
      };
    }
    jobsByRunId[run.id] = Array.isArray(jobsData.jobs) ? jobsData.jobs : [];
  }

  const latestRuns = pickLatestRunPerWorkflow(scopedRuns, jobsByRunId);

  const result = evaluatePrGreen(latestRuns, jobsByRunId);

  // `events` を渡した呼び出しでは `findMissingRequiredGates` を不活性にする: 絞り込みが pull_request 専用の run を落とし、真の欠落でない門を誤検知するため。
  const scoped = events !== undefined && events !== null;
  // `--repo` で既定以外を指定した呼び出しも不活性にする: 読むのは `takecchi/alteroid` の宣言で、他の repo の門を「無い」と誤判定するため。
  const crossRepo = repo !== DEFAULT_REPO;
  const { contexts: requiredContexts, error: declarationError } = loadRequiredContexts();
  const missingRequiredGates =
    requiredContexts === null
      ? { status: 'error', reason: declarationError }
      : findMissingRequiredGates({
          requiredContexts,
          verdict: result.verdict,
          scoped,
          crossRepo,
          latestRuns,
          jobsByRunId,
        });

  return { result, latestRuns, jobsByRunId, error: null, missingRequiredGates };
}

function main() {
  const { sha, repo } = parseArgs(process.argv.slice(2));
  if (sha === null || sha.trim() === '') {
    logError('check-pr-green: 使い方: node ./scripts/check-pr-green.mjs <sha> [--repo owner/repo]');
    process.exitCode = 1;
    return;
  }

  const { result, error, missingRequiredGates } = judgeSha({ sha, repo });
  if (result === null) {
    logError(`check-pr-green(${sha}): 判定できなかった —— ${error}`);
    process.exitCode = 1;
    return;
  }

  if (missingRequiredGates?.status === 'error') {
    logError(
      `check-pr-green(${sha}): required contexts の宣言を読めなかった —— 「required なのに run が無い門」の検査は今回スキップされた: ${missingRequiredGates.reason}`,
    );
  }

  // `formatVerdict(sha, result)` をそのまま並べない: 「check-pr-green(sha): OK」の単独の行ができ、OK で grep する読み手が NG の直後の行だけを見て緑と誤読するため。
  if (missingRequiredGates?.status === 'checked' && missingRequiredGates.missing.length > 0) {
    logError(formatMissingRequiredGates(sha, missingRequiredGates.missing, result));
    process.exitCode = 1;
    return;
  }

  const text = formatVerdict(sha, result);

  if (result.verdict === 'green') {
    log(text);
    return;
  }
  logError(text);
  process.exitCode = result.verdict === 'out-of-scope' ? 2 : 1;
}

// 直接起動されたときだけ走らせる: import されたとき（`judgeSha` の利用）に副作用として CLI が起きないようにするため。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

#!/usr/bin/env node
/**
 * 指定した sha の CI が「本当に緑か」を判定する（Issue #933）。
 *
 * **判定ロジックはここに置かない。** `check-pr-green-core.mjs` が正本で、
 * なぜ `check-runs`（世代の順序を決めるキーが無い）を経由せず `actions/runs`
 * から降りるのかは、あちらの doc に書いてある。ここはネットワーク（`gh api`）
 * を持ち、結果を出力し、終了コードを決めるだけの薄い層
 * （`check-required-status-checks.mjs` / `check-base-overlap.mjs` と同じ分け方）。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: 指定した sha について、workflow 名ごとに最新の run を選び、
 *   その run の jobs がすべて `success` か。
 * - **言えないこと**: **これが最後の世代だという保証。** 呼んだ直後にもう1本
 *   run が作られうる（`gh pr ready` が新しい run を起こす、再実行される、
 *   等）。緑は「いま見た時点でそうだった」だけを言う。
 * - **測っていないこと**: 同じ workflow 名で `workflow_dispatch` と
 *   `pull_request` が混ざる sha、再実行（`rerun`）で3世代目が生える sha は
 *   実測していない（`check-pr-green-core.mjs` の doc）。
 * - **書き換えない。** 読むだけである。
 *
 * ## 使い方
 *
 *     node ./scripts/check-pr-green.mjs <sha> [--repo owner/repo]
 *
 * `--repo` の既定は `takecchi/alteroid`。
 *
 * ## 終了コード
 *
 * | verdict | コード |
 * |---|---|
 * | green | 0 |
 * | red / pending / unmeasurable / no-runs | 1 |
 *
 * **`pending`（まだ走行中）と `red`（赤）を同じ 1 にしてあるが、出力の文言は
 * 別である。** どちらも「緑と確定していない」ことが要点なので終了コードは
 * 分けず、**何が起きたかは必ず1行目で名乗る**（`AGENTS.md`「静かに失敗する
 * 道具」）。
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import {
  evaluatePrGreen,
  formatVerdict,
  pickLatestRunPerWorkflow,
} from './check-pr-green-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function parseArgs(argv) {
  let sha = null;
  let repo = 'takecchi/alteroid';
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

/** `gh api` を呼び、JSON を返す。失敗したら `{ error }` を返す（例外を投げない）。 */
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

function main() {
  const { sha, repo } = parseArgs(process.argv.slice(2));
  if (sha === null || sha.trim() === '') {
    logError('check-pr-green: 使い方: node ./scripts/check-pr-green.mjs <sha> [--repo owner/repo]');
    process.exitCode = 1;
    return;
  }

  const runsPath = `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`;
  const { data: runsData, error: runsError } = ghApiJson(runsPath);
  if (runsData === null) {
    logError(`check-pr-green(${sha}): 判定できなかった —— run 一覧を読めない`);
    logError(`  gh の出力: ${runsError}`);
    process.exitCode = 1;
    return;
  }

  const runs = Array.isArray(runsData.workflow_runs) ? runsData.workflow_runs : [];
  const latestRuns = pickLatestRunPerWorkflow(runs);

  const jobsByRunId = {};
  for (const run of latestRuns) {
    if (run.status !== 'completed') continue; // まだ終わっていない run の jobs は問い合わせるだけ無駄
    const { data: jobsData, error: jobsError } = ghApiJson(
      `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
    );
    if (jobsData === null) {
      logError(`check-pr-green(${sha}): 判定できなかった —— run ${run.id} の jobs を読めない`);
      logError(`  gh の出力: ${jobsError}`);
      process.exitCode = 1;
      return;
    }
    jobsByRunId[run.id] = Array.isArray(jobsData.jobs) ? jobsData.jobs : [];
  }

  const result = evaluatePrGreen(latestRuns, jobsByRunId);
  const text = formatVerdict(sha, result);

  if (result.verdict === 'green') {
    log(text);
    return;
  }
  logError(text);
  process.exitCode = 1;
}

main();

// 「赤なら止める」門は作らず記録だけにする: 門が発動する場面がほぼ無く、赤の大半は flaky による誤停止で、反映は夜1回なので止まった場合の空白が最長で丸1日になるため。
// 判定器は `scripts/check-pr-green.mjs` の `judgeSha` を呼び、再実装しない: 2本目を書くと世代選び（workflow名＋event の組・`created_at`/`id` の tiebreak）が2箇所でずれるため。
// `out-of-scope` は異常なし: `push` の run では `pull_request` 専用 job が設計どおり skip され、健全な `main` HEAD も `green` にならず `out-of-scope` になるため。他の非 green と同列に扱わない。
// 記録行は `release-prod-ci-record: ` で始める: 後からこの文字列で数えるので、変えると過去の記録が grep から見えなくなるため。
// `main-ci-alarm` の鍵は写さず `main-ci-alarm-core.mjs` から import して使う: 写すと鍵の形が2箇所でずれ、同じ sha で別の鍵を作って「見つからない」が起きるため。
// 新しい Issue は立てず、警報 Issue が open のときだけコメントを足す: 記録できなかったこと自体は反映を止めない。
// 赤の晩だけ Issue にも残す: run のログは90日で消えるが、緑の晩は書く先が無く run のログで足りるため。

import {
  CANCEL_AWARE_WORKFLOW_NAME,
  GATE_JOB_NAME,
  isCancelledRun,
} from '../../scripts/main-ci-alarm-core.mjs';

export const RECORD_LINE_PREFIX = 'release-prod-ci-record:';

// verdict と別に health 欄を持つ: 記録行の `verdict=out-of-scope` という文字列だけでは「異常なし」と読まれず、判定できなかったと誤読されるため。
// 3値にする: 2値だと「判定に至れなかった」を `ok` か `bad` へ畳み、取れない軸に値を作ることになるため。
export function healthOf(verdict) {
  if (verdict === 'green' || verdict === 'out-of-scope') return 'ok';
  if (verdict === 'red') return 'bad';
  return 'unknown';
}

export function buildRecordLine({ verdict, prodSha, mainSha, reflectOutcome, observedAt }) {
  return (
    `${RECORD_LINE_PREFIX} verdict=${verdict} health=${healthOf(verdict)} ` +
    `prod_sha=${prodSha} main_sha=${mainSha} reflect=${reflectOutcome} observed_at=${observedAt}`
  );
}

export function describeVerdict(verdict) {
  switch (verdict) {
    case 'green':
      return '緑 —— 反映した sha の最新世代の job がすべて success だった';
    case 'red':
      return '赤 —— success ではない job が在った。赤い main が本番へ出た';
    case 'cancelled':
      return '中断 —— 赤ではないが、走り切っていない job が在った（判定不能。門ではないので反映は止めていない）';
    case 'out-of-scope':
      return (
        '異常なし —— push の run なので pull_request 専用 job（base-overlap / pr-origin 等）が' +
        '設計どおり skip されただけ。健全な main HEAD でも green にはならずこの verdict になる' +
        '（実測: 健全な main HEAD ecd1674e09c72b245db21b225f56ac590fd336af = out-of-scope）'
      );
    case 'skipped':
      return 'draft 由来の skip の疑いが在る job が見つかった（本来 push の run では起きないはずの形。要確認）';
    case 'unmeasurable':
      return '判定できない —— jobs が0件の run が在る、または job がすべて skipped で success と言える job が無い';
    case 'no-runs':
      return '判定できない —— この sha に workflow run が1つも無い';
    case 'pending':
      return '判定できない —— まだ完了していない run が在る（反映直後に判定を試みた等）';
    case 'unknown':
      return '判定できない —— gh api を読めなかった、または main_sha / prod_sha を取得できなかった';
    default:
      return `未知の verdict: ${verdict}`;
  }
}

// detail 文字列を parse しない: `evaluatePrGreen` の戻り値には run 自体の `conclusion` が乗っており、detail の文言が変わっても影響を受けないため。
export function redWorkflowNames(latestRuns) {
  const names = new Set();
  for (const run of latestRuns) {
    if (run.conclusion === 'failure') names.add(run.name);
  }
  return [...names];
}

// 印の `run` は落ちた CI の run ではなく `release-prod.yml` 自身の反映 run の id（`GITHUB_RUN_ID`）にする: 同じ夜間反映の run が再実行されても二重に足さないため。
export function recordCommentMarker({ sha, runId }) {
  return `<!-- alteroid:release-prod-ci-record sha=${sha} run=${runId} -->`;
}

export function buildRecordComment({
  sha,
  runId,
  runUrl,
  verdict,
  redWorkflows,
  mainSha,
  reflectOutcome,
  observedAt,
}) {
  return [
    '**この赤は本番へ出た。**',
    '',
    `\`release/prod\` への夜間反映（\`.github/workflows/release-prod.yml\`）が` +
      ` \`${sha}\`（main \`${mainSha}\`）を反映したあと、その sha の CI 判定は` +
      ` \`${verdict}\` だった。`,
    '',
    `- run ${runId}: ${runUrl}`,
    `- 落ちていた workflow: ${redWorkflows.length > 0 ? redWorkflows.join(', ') : '(不明)'}`,
    `- reflect の結果: ${reflectOutcome}`,
    `- 観測時刻: ${observedAt}`,
    '',
    buildRecordLine({ verdict, prodSha: sha, mainSha, reflectOutcome, observedAt }),
    '',
    'この記録は門ではない——赤くても反映は止めていない（Issue #1207 の (3)。',
    '決定と根拠は `.github/scripts/record-release-prod-ci-core.mjs` の doc を見よ）。',
    '',
    recordCommentMarker({ sha, runId }),
  ].join('\n');
}

// `red` を `cancelled` へ倒すのは記録の側だけにする: `evaluatePrGreen` / `check-pr-green` を変えると、取り消しを通す方向へ PR の緑の判定を緩める経路ができるため。jobs が取れない・渡されないときは倒さず `red` のままにする。
export function refineVerdictForCancelledRuns({ verdict, latestRuns, jobsByRunId }) {
  if (verdict !== 'red') return verdict;
  if (!Array.isArray(latestRuns) || latestRuns.length === 0) return verdict;
  if (jobsByRunId === null || typeof jobsByRunId !== 'object') return verdict;

  let sawCancelledCi = false;
  for (const run of latestRuns) {
    const jobs = run.id === null ? undefined : jobsByRunId[run.id];
    if (!Array.isArray(jobs)) return verdict;
    const cancelledCi = run.name === CANCEL_AWARE_WORKFLOW_NAME && isCancelledRun(jobs);
    if (cancelledCi) sawCancelledCi = true;
    for (const job of jobs) {
      const c = job.conclusion ?? '';
      if (c === 'success' || c === 'skipped' || c === 'cancelled') continue;
      if (cancelledCi && job.name === GATE_JOB_NAME) continue;
      return verdict;
    }
  }
  return sawCancelledCi ? 'cancelled' : verdict;
}

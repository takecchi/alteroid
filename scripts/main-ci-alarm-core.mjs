// 「赤なら止める」門を足さない: 28日で発動0回・6件中5件は flaky による誤停止で、反映が夜1回のため空白が最長で丸1日になる。
// 宛先は Issue 1つに絞る: 新しい自動投稿の宛先を無断で作らない方針のため。Slack や外部の `POST /events`（source の検証が無い）は叩かない。
// 「open な警報 Issue が1つでも在れば黙る」形にしない: 誰も閉じない1本が以後すべての警報を飲み込むため。run ごとに1本立てる形にもしない: 赤が続くと夜の反映のたびに Issue が生えるため。
// 自動で閉じない: `workflow_run` の `success` にも反応してマージのたびに job が起き、警報1回のために釣り合わないため。

// 印の接頭辞を変えない: 過去の警報 Issue が見つからなくなり、同じ赤で2本目が立つため。
export const ALARM_MARKER_PREFIX = 'alteroid:main-ci-alarm';

// workflow 名を slug へ潰さない: `CI` と `C-I` のような別物が同じ鍵になりうるため。
export function alarmKey(workflowName, headSha) {
  return `${workflowName}@${headSha}`;
}

export function alarmMarker(key) {
  return `<!-- ${ALARM_MARKER_PREFIX} key=${key} -->`;
}

// `pull_request` プロパティを持つものを落とす: `repos/{repo}/issues` は PR も混ぜて返し、本文に印を含む PR を警報 Issue と取り違えるため。
export function findOpenAlarmIssue(issues, marker) {
  return (
    issues.find(
      (issue) =>
        issue.pull_request === undefined &&
        typeof issue.body === 'string' &&
        issue.body.includes(marker),
    ) ?? null
  );
}

export function runAlreadyMentioned(texts, runId) {
  const needle = runMention(runId);
  return texts.some((text) => typeof text === 'string' && text.includes(needle));
}

export function runMention(runId) {
  return `run ${runId}`;
}

// `workflow_run` の conclusion だけで判定せず jobs を見る: `ci` ジョブは cancelled でも `exit 1` するため、取り消された run も `failure` になり本物の失敗と見分けられない。
export const CANCEL_AWARE_WORKFLOW_NAME = 'CI';
export const GATE_JOB_NAME = 'ci';

const NOT_FAILED_CONCLUSIONS = new Set(['success', 'skipped', 'cancelled', 'neutral']);

// jobs が取れなかったときや本物の失敗が cancelled と混ざっているときは取り消しとみなさない: 警報が黙って消えるため。
export function isCancelledRun(jobs) {
  if (!Array.isArray(jobs)) return false;
  const failed = jobs.filter((j) => !NOT_FAILED_CONCLUSIONS.has(j.conclusion ?? ''));
  if (failed.length === 0) return false;
  if (!failed.every((j) => j.name === GATE_JOB_NAME)) return false;
  return jobs.some((j) => j.conclusion === 'cancelled');
}

// workflow 側の `if:` と二重に見る: `if:` は外した・書き間違えたときに静かに全部通す側へ倒れるため。
export function shouldAlarm({ conclusion, headBranch, defaultBranch, workflowName, jobs }) {
  if (conclusion !== 'failure') {
    return { alarm: false, reason: `conclusion=${conclusion} は failure ではない` };
  }
  if (headBranch !== defaultBranch) {
    // PR の run は警報の対象にしない: PR の赤は PR の画面に出ており、知らせる経路が無いのは main のほうのため。
    return {
      alarm: false,
      reason: `head_branch=${headBranch} は default branch（${defaultBranch}）ではない`,
    };
  }
  if (workflowName === CANCEL_AWARE_WORKFLOW_NAME && isCancelledRun(jobs)) {
    return {
      alarm: false,
      reason: `失敗したのは集約ゲート（${GATE_JOB_NAME}）だけで、ほかの job が cancelled —— 取り消された run であって本物の失敗ではない`,
    };
  }
  return { alarm: true, reason: `${defaultBranch} の run が failure で終わった` };
}

export function decideAlarmAction({ issue, commentBodies, runId }) {
  if (issue === null) {
    return { kind: 'create', reason: 'この鍵の open な警報 Issue が無い' };
  }
  const texts = [issue.body ?? '', ...commentBodies];
  if (runAlreadyMentioned(texts, runId)) {
    return {
      kind: 'skip',
      issueNumber: issue.number,
      reason: `#${issue.number} に ${runMention(runId)} が既に書かれている`,
    };
  }
  return {
    kind: 'comment',
    issueNumber: issue.number,
    reason: `#${issue.number} が同じ鍵で open なので、そこへ足す`,
  };
}

// タイトルに sha を12桁入れる: 一覧で同じ赤の続きか別の赤かがタイトルだけで分かるようにするため。
export function buildIssueTitle({ workflowName, headSha }) {
  return `${workflowName} が main で落ちた（${headSha.slice(0, 12)}）`;
}

// 本文に「次の一手」（run の URL・落ちた workflow・sha・この Issue を閉じてよい条件）を書く: 「赤いですよ」だけだと読んだ側が Actions を開いて辿り直すことになるため。
export function buildIssueBody({ workflowName, headSha, runId, runUrl, key, extraLines = [] }) {
  return [
    `**\`main\` で \`${workflowName}\` が失敗した。**`,
    '',
    `- sha: \`${headSha}\``,
    `- ${runMention(runId)}: ${runUrl}`,
    '',
    ...extraLines,
    ...(extraLines.length > 0 ? [''] : []),
    '## これは何か',
    '',
    '`main` の post-merge CI が落ちても知らせる経路が repo の中に1本も無かった',
    '（#1207。28日で6回落ちていた）。**この Issue はその経路そのものである** ——',
    '`.github/workflows/main-ci-alarm.yml` が `workflow_run` で失敗を拾って立てている。',
    '',
    '## 閉じてよいとき',
    '',
    '**直したら手で閉じてよい。** この仕掛けは Issue を自動では閉じない',
    "（理由の逐語は `grep -Fn -- '閉じるのは人である' scripts/main-ci-alarm-core.mjs`）。",
    '同じ sha で同じ workflow がまた落ちた場合は、新しい Issue ではなく',
    'この Issue へコメントが足される。**`main` が進めば別の Issue になる。**',
    '',
    alarmMarker(key),
  ].join('\n');
}

export function buildCommentBody({ workflowName, headSha, runId, runUrl, extraLines = [] }) {
  return [
    `**同じ sha でまた失敗した。** \`${workflowName}\` / \`${headSha.slice(0, 12)}\``,
    '',
    `- ${runMention(runId)}: ${runUrl}`,
    ...(extraLines.length > 0 ? ['', ...extraLines] : []),
  ].join('\n');
}

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { listWorkflowFiles } from './workflow-scan-core.mjs';

import {
  ALARM_MARKER_PREFIX,
  CANCEL_AWARE_WORKFLOW_NAME,
  GATE_JOB_NAME,
  alarmKey,
  alarmMarker,
  buildCommentBody,
  buildIssueBody,
  buildIssueTitle,
  decideAlarmAction,
  findOpenAlarmIssue,
  isCancelledRun,
  runAlreadyMentioned,
  runMention,
  shouldAlarm,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './main-ci-alarm-core.mjs';

/**
 * `main-ci-alarm` の歯（Issue #1207）。
 *
 * 本物の `gh` は叩かない —— 合成した応答で判定だけを確かめる
 * （`check-pr-green.test.ts` と同じ理由。手元は offline でありうるし、
 * 本物の Issue を立てる実験はできない）。
 *
 * **下の固定値は実測を写したものである。** `main` の post-merge CI が落ちた6回は
 * #1207 本文の表に在り、そのうち最長の赤い区間（約2時間13分）が
 * `3ca63973b7dae66b48b033a962a92e19c7e73e63` / run `34709221407`
 * （2026-09-12T17:46:25Z、`gh api repos/takecchi/alteroid/actions/runs/34709221407`
 * で観測 2026-09-18）である。ここではその実データを代表として使う。
 *
 * ⛔ **この歯が固定していないもの**: `workflow_run` が実際に発火すること。
 * `workflow_run` の workflow は default branch のファイルしか使われないので、
 * **マージするまで1度も鳴らない**（`.github/workflows/main-ci-alarm.yml` の
 * 「この workflow は PR では試せない」）。ここで緑になっても、鳴ることの証明ではない。
 */

/** 実測（run 34709221407）。28日で6回落ちたうち、赤い区間が最長だった回。 */
const REAL = {
  workflowName: 'CI',
  headSha: '3ca63973b7dae66b48b033a962a92e19c7e73e63',
  runId: 34709221407,
  runUrl: 'https://github.com/takecchi/alteroid/actions/runs/34709221407',
};

describe('shouldAlarm', () => {
  it('main の run が failure なら鳴らす', () => {
    const result = shouldAlarm({
      conclusion: 'failure',
      headBranch: 'main',
      defaultBranch: 'main',
    });
    expect(result.alarm).toBe(true);
  });

  it('success では鳴らさない（この道具は失敗にしか反応しない）', () => {
    const result = shouldAlarm({
      conclusion: 'success',
      headBranch: 'main',
      defaultBranch: 'main',
    });
    expect(result.alarm).toBe(false);
    expect(result.reason).toContain('failure ではない');
  });

  it('PR の枝の失敗では鳴らさない —— PR の赤は PR の画面に出ている', () => {
    const result = shouldAlarm({
      conclusion: 'failure',
      headBranch: 'feat/something',
      defaultBranch: 'main',
    });
    expect(result.alarm).toBe(false);
    expect(result.reason).toContain('default branch');
  });

  it('⭐ conclusion が null（まだ終わっていない等）でも鳴らさない', () => {
    // `workflow_run` の `completed` は cancelled / skipped / null も運んでくる。
    // **「success でなければ赤」の1本判定にすると、中断や skip で Issue が生える。**
    for (const conclusion of [null, 'cancelled', 'skipped', 'neutral', 'timed_out']) {
      const result = shouldAlarm({ conclusion, headBranch: 'main', defaultBranch: 'main' });
      expect(result.alarm, `conclusion=${conclusion}`).toBe(conclusion === 'failure');
    }
  });
});

/**
 * 取り消された run の見分け（Issue #3044）。
 *
 * 固定値は実測を写したもの: run 37372223779（CI、main、2026-10 観測。#3040 の偽の警報）の
 * jobs は `checks=cancelled / test (1/2)=cancelled / test (2/2)=cancelled / image=success /
 * ci=failure` だった（`gh api repos/takecchi/alteroid/actions/runs/37372223779/jobs`）。
 */
const CANCELLED_RUN_JOBS = [
  { name: 'checks', conclusion: 'cancelled' },
  { name: 'test (1/2)', conclusion: 'cancelled' },
  { name: 'test (2/2)', conclusion: 'cancelled' },
  { name: 'image', conclusion: 'success' },
  { name: 'ci', conclusion: 'failure' },
];

const MAIN_FAILURE = {
  conclusion: 'failure',
  headBranch: 'main',
  defaultBranch: 'main',
  workflowName: 'CI',
};

describe('isCancelledRun / shouldAlarm（取り消された run は鳴らさない）', () => {
  it('⭐ run 37372223779 型（ゲートの ci だけが failure、ほかは cancelled / success）は鳴らさない', () => {
    expect(isCancelledRun(CANCELLED_RUN_JOBS)).toBe(true);
    const result = shouldAlarm({ ...MAIN_FAILURE, jobs: CANCELLED_RUN_JOBS });
    expect(result.alarm).toBe(false);
    expect(result.reason).toContain('取り消された');
  });

  it('本物の失敗（test が failure、ゲートも failure）は鳴らす', () => {
    const jobs = [
      { name: 'checks', conclusion: 'success' },
      { name: 'test (1/2)', conclusion: 'failure' },
      { name: 'test (2/2)', conclusion: 'success' },
      { name: 'image', conclusion: 'success' },
      { name: 'ci', conclusion: 'failure' },
    ];
    expect(isCancelledRun(jobs)).toBe(false);
    expect(shouldAlarm({ ...MAIN_FAILURE, jobs }).alarm).toBe(true);
  });

  it('⭐ 本物の失敗が cancelled と混ざっているときは鳴らす', () => {
    const jobs = [
      { name: 'checks', conclusion: 'failure' },
      { name: 'test (1/2)', conclusion: 'cancelled' },
      { name: 'test (2/2)', conclusion: 'cancelled' },
      { name: 'ci', conclusion: 'failure' },
    ];
    expect(isCancelledRun(jobs)).toBe(false);
    expect(shouldAlarm({ ...MAIN_FAILURE, jobs }).alarm).toBe(true);
  });

  it('failure 以外の非成功（timed_out など）も本物の失敗側に数える', () => {
    const jobs = [
      { name: 'checks', conclusion: 'timed_out' },
      { name: 'test (1/2)', conclusion: 'cancelled' },
      { name: 'ci', conclusion: 'failure' },
    ];
    expect(isCancelledRun(jobs)).toBe(false);
  });

  it('⭐ jobs を取れなかった（null）ときは今までどおり鳴らす（黙って消さない）', () => {
    expect(isCancelledRun(null)).toBe(false);
    expect(shouldAlarm({ ...MAIN_FAILURE, jobs: null }).alarm).toBe(true);
  });

  it('jobs を渡さない（従来の呼び方）ときも鳴らす', () => {
    expect(shouldAlarm(MAIN_FAILURE).alarm).toBe(true);
  });

  it('jobs が空のときは鳴らす（説明のつかない赤）', () => {
    expect(shouldAlarm({ ...MAIN_FAILURE, jobs: [] }).alarm).toBe(true);
  });

  it('cancelled が1つも無く ci だけが failure のときは鳴らす（取り消しの証拠が無い）', () => {
    const jobs = [
      { name: 'checks', conclusion: 'success' },
      { name: 'ci', conclusion: 'failure' },
    ];
    expect(isCancelledRun(jobs)).toBe(false);
    expect(shouldAlarm({ ...MAIN_FAILURE, jobs }).alarm).toBe(true);
  });

  it('CI 以外の workflow は、jobs が取り消しの形でも従来どおり鳴らす', () => {
    const result = shouldAlarm({
      ...MAIN_FAILURE,
      workflowName: 'release/prod へ反映',
      jobs: CANCELLED_RUN_JOBS,
    });
    expect(result.alarm).toBe(true);
  });

  it('取り消しの形でも、PR の枝・failure 以外の既存の判定は変わらない', () => {
    expect(
      shouldAlarm({ ...MAIN_FAILURE, headBranch: 'feat/x', jobs: CANCELLED_RUN_JOBS }).reason,
    ).toContain('default branch');
    expect(shouldAlarm({ ...MAIN_FAILURE, conclusion: 'success', jobs: [] }).reason).toContain(
      'failure ではない',
    );
  });
});

describe('鍵（どの workflow が、どの sha で落ちたか）', () => {
  it('workflow 名と sha の両方が鍵に入る', () => {
    const key = alarmKey(REAL.workflowName, REAL.headSha);
    expect(key).toBe(`CI@${REAL.headSha}`);
  });

  it('⭐ 同じ sha でも workflow が違えば別の鍵になる', () => {
    // 赤い main（`CI`）と、それを理由に止まった夜の反映（`release/prod へ反映`）は
    // 別の事実である。1本にまとめると、どちらが起きたのか読めなくなる。
    expect(alarmKey('CI', REAL.headSha)).not.toBe(alarmKey('release/prod へ反映', REAL.headSha));
  });

  it('⭐ 同じ workflow でも sha が違えば別の鍵になる（main が進めば別の赤）', () => {
    expect(alarmKey('CI', REAL.headSha)).not.toBe(alarmKey('CI', '1d1bb8c84c3c'));
  });

  it('印は接頭辞と鍵を含む HTML コメントである', () => {
    const marker = alarmMarker(alarmKey(REAL.workflowName, REAL.headSha));
    expect(marker.startsWith('<!-- ')).toBe(true);
    expect(marker.endsWith(' -->')).toBe(true);
    expect(marker).toContain(ALARM_MARKER_PREFIX);
    expect(marker).toContain(REAL.headSha);
  });
});

describe('findOpenAlarmIssue', () => {
  const marker = alarmMarker(alarmKey(REAL.workflowName, REAL.headSha));

  it('印を本文に持つ Issue を見つける', () => {
    const issues = [
      { number: 1, body: '関係ない Issue' },
      { number: 2, body: `本文\n\n${marker}` },
    ];
    expect(findOpenAlarmIssue(issues, marker)?.number).toBe(2);
  });

  it('無ければ null（＝新しく立てる側へ倒れる）', () => {
    expect(findOpenAlarmIssue([{ number: 1, body: 'ほかの話' }], marker)).toBe(null);
  });

  it('⭐ Pull Request は除く —— `repos/{repo}/issues` は PR も混ぜて返す', () => {
    // この PR 自身が本文に印を含みうる（doc に書式を載せているため）。
    // 落とさないと、自分の PR を警報 Issue と取り違えてそこへコメントしに行く。
    const issues = [
      { number: 1207, body: `PR の本文に印がある\n${marker}`, pull_request: { url: 'x' } },
      { number: 1208, body: `本物の警報\n${marker}` },
    ];
    expect(findOpenAlarmIssue(issues, marker)?.number).toBe(1208);
  });

  it('⭐ 別の鍵の警報 Issue は拾わない', () => {
    const otherMarker = alarmMarker(alarmKey('CI', '1d1bb8c84c3c'));
    const issues = [{ number: 5, body: `別の赤\n${otherMarker}` }];
    expect(findOpenAlarmIssue(issues, marker)).toBe(null);
  });

  it('body が null の Issue が混ざっても落ちない', () => {
    const issues = [
      { number: 1, body: null },
      { number: 2, body: marker },
    ];
    expect(findOpenAlarmIssue(issues, marker)?.number).toBe(2);
  });
});

describe('decideAlarmAction', () => {
  it('open な警報 Issue が無ければ立てる', () => {
    const action = decideAlarmAction({ issue: null, commentBodies: [], runId: REAL.runId });
    expect(action.kind).toBe('create');
  });

  it('同じ鍵で open な Issue が在れば、そこへコメントを足す', () => {
    const action = decideAlarmAction({
      issue: { number: 42, body: '前の赤' },
      commentBodies: [],
      runId: REAL.runId,
    });
    expect(action.kind).toBe('comment');
    expect(action.issueNumber).toBe(42);
  });

  it('⭐ 同じ run が既に書かれていれば何もしない（警報の再実行で増やさない）', () => {
    const body = buildIssueBody({
      ...REAL,
      key: alarmKey(REAL.workflowName, REAL.headSha),
    });
    const action = decideAlarmAction({
      issue: { number: 42, body },
      commentBodies: [],
      runId: REAL.runId,
    });
    expect(action.kind).toBe('skip');
  });

  it('⭐ 同じ run がコメント側に在っても何もしない', () => {
    const comment = buildCommentBody(REAL);
    const action = decideAlarmAction({
      issue: { number: 42, body: '別の run の話' },
      commentBodies: [comment],
      runId: REAL.runId,
    });
    expect(action.kind).toBe('skip');
  });

  it('別の run なら、同じ Issue へ足す', () => {
    const comment = buildCommentBody({ ...REAL, runId: 34709221407 });
    const action = decideAlarmAction({
      issue: { number: 42, body: '前の赤' },
      commentBodies: [comment],
      runId: 34999999999,
    });
    expect(action.kind).toBe('comment');
  });
});

describe('runAlreadyMentioned', () => {
  it('run の言及は本文とコメントで同じ形である', () => {
    const mention = runMention(REAL.runId);
    expect(buildCommentBody(REAL)).toContain(mention);
    expect(buildIssueBody({ ...REAL, key: 'k' })).toContain(mention);
    expect(runAlreadyMentioned([buildCommentBody(REAL)], REAL.runId)).toBe(true);
  });

  it('別の run は見つからない', () => {
    expect(runAlreadyMentioned([buildCommentBody(REAL)], 34999999999)).toBe(false);
  });
});

describe('Issue の中身', () => {
  const key = alarmKey(REAL.workflowName, REAL.headSha);

  it('タイトルに workflow 名と短い sha が入る（一覧で別の赤と見分けられる）', () => {
    const title = buildIssueTitle(REAL);
    expect(title).toContain('CI');
    expect(title).toContain('3ca63973b7da');
  });

  it('⭐ 本文に「次の一手」が全部入る —— sha・run の URL・印', () => {
    const body = buildIssueBody({ ...REAL, key });
    expect(body).toContain(REAL.headSha);
    expect(body).toContain(REAL.runUrl);
    expect(body).toContain(alarmMarker(key));
  });

  it('⭐ 本文に「閉じてよいとき」が書いてある（自動では閉じないので）', () => {
    expect(buildIssueBody({ ...REAL, key })).toContain('閉じてよい');
  });

  it('コメントは同じ sha でまた落ちたことを名乗る', () => {
    const comment = buildCommentBody(REAL);
    expect(comment).toContain('3ca63973b7da');
    expect(comment).toContain(REAL.runUrl);
  });
});

// ============================================================================
// 監視対象の名前が実在する（Issue #1314）
// ============================================================================

/**
 * **この警報は監視対象を「workflow の `name:`」という文字列で持っている。**
 * `main-ci-alarm.yml` 自身の doc が逐語でその危うさを言う——
 * `grep -Fn -- '片方だけ直すと静かに鳴らなくなる' .github/workflows/main-ci-alarm.yml`。
 *
 * 🔴 **鳴らなくなっても赤くならない。** 名前がずれた警報は `workflow_run` が一致
 * しなくなるだけで、**エラーも出さずに静かに何もしなくなる**（AGENTS.md「静かに
 * 失敗する道具」）。⟹ **ずれたことを観測する口が要る。**
 *
 * ⚠️ **片側だけを固定しない。** 期待値をこの歯に直書きすると、監視対象を1本
 * 増やすたびにここも直す二重管理になる。**両側とも現物から読む** ——
 * `main-ci-alarm.yml` の `workflows:` と、`.github/workflows/` 配下の実在の
 * `name:` を突き合わせる。
 */
const WORKFLOWS_DIR = path.join(fileURLToPath(new URL('..', import.meta.url)), '.github/workflows');

/** workflow ファイルの先頭の `name:` を返す（無ければ `null`）。 */
function topLevelWorkflowName(text: string): string | null {
  for (const line of text.split('\n')) {
    const m = /^name:\s*(.+?)\s*$/.exec(line);
    const captured = m?.[1];
    if (captured !== undefined) return captured.replace(/^["']|["']$/g, '');
  }
  return null;
}

/** `on.workflow_run.workflows:` の並びを読む。コメント行は落とす。 */
function watchedWorkflowNames(text: string): string[] {
  const marker = '    workflows:\n';
  const start = text.indexOf(marker);
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of text.slice(start + marker.length).split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = /^ {6}- (.+?)\s*$/.exec(line);
    const captured = m?.[1];
    if (captured === undefined) break;
    names.push(captured);
  }
  return names;
}

describe('main-ci-alarm の監視対象は実在する workflow の名前である', () => {
  const alarmText = readFileSync(path.join(WORKFLOWS_DIR, 'main-ci-alarm.yml'), 'utf8');
  const watched = watchedWorkflowNames(alarmText);
  const actualNames = new Set(
    (listWorkflowFiles(WORKFLOWS_DIR) as string[])
      .map((f) => topLevelWorkflowName(readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8')))
      .filter((n): n is string => n !== null),
  );

  it('前提: 監視対象を1本以上読めている（走査が空を「全部一致」へ倒さない）', () => {
    expect(watched.length).toBeGreaterThan(0);
    expect(actualNames.size).toBeGreaterThan(watched.length);
  });

  it('監視対象の名前は、すべて .github/workflows/ の実在する name: である', () => {
    for (const name of watched) {
      expect(
        [...actualNames],
        `main-ci-alarm.yml が監視する "${name}" に一致する workflow の name: が無い` +
          ` —— 名前を変えたなら両側を直すこと。片方だけだと静かに鳴らなくなる`,
      ).toContain(name);
    }
  });
});

describe('取り消し判定の名前が ci.yml と一致する', () => {
  const ciText = readFileSync(path.join(WORKFLOWS_DIR, 'ci.yml'), 'utf8');

  it('workflow 名と集約ゲートの job 名（name: を持たない job キー）が ci.yml に在る', () => {
    expect(topLevelWorkflowName(ciText)).toBe(CANCEL_AWARE_WORKFLOW_NAME);
    expect(ciText).toMatch(new RegExp(`^  ${GATE_JOB_NAME}:\\s*import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { listWorkflowFiles } from './workflow-scan-core.mjs';

import {
  ALARM_MARKER_PREFIX,
  CANCEL_AWARE_WORKFLOW_NAME,
  GATE_JOB_NAME,
  alarmKey,
  alarmMarker,
  buildCommentBody,
  buildIssueBody,
  buildIssueTitle,
  decideAlarmAction,
  findOpenAlarmIssue,
  isCancelledRun,
  runAlreadyMentioned,
  runMention,
  shouldAlarm,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './main-ci-alarm-core.mjs';

/**
 * `main-ci-alarm` の歯（Issue #1207）。
 *
 * 本物の `gh` は叩かない —— 合成した応答で判定だけを確かめる
 * （`check-pr-green.test.ts` と同じ理由。手元は offline でありうるし、
 * 本物の Issue を立てる実験はできない）。
 *
 * **下の固定値は実測を写したものである。** `main` の post-merge CI が落ちた6回は
 * #1207 本文の表に在り、そのうち最長の赤い区間（約2時間13分）が
 * `3ca63973b7dae66b48b033a962a92e19c7e73e63` / run `34709221407`
 * （2026-09-12T17:46:25Z、`gh api repos/takecchi/alteroid/actions/runs/34709221407`
 * で観測 2026-09-18）である。ここではその実データを代表として使う。
 *
 * ⛔ **この歯が固定していないもの**: `workflow_run` が実際に発火すること。
 * `workflow_run` の workflow は default branch のファイルしか使われないので、
 * **マージするまで1度も鳴らない**（`.github/workflows/main-ci-alarm.yml` の
 * 「この workflow は PR では試せない」）。ここで緑になっても、鳴ることの証明ではない。
 */

/** 実測（run 34709221407）。28日で6回落ちたうち、赤い区間が最長だった回。 */
const REAL = {
  workflowName: 'CI',
  headSha: '3ca63973b7dae66b48b033a962a92e19c7e73e63',
  runId: 34709221407,
  runUrl: 'https://github.com/takecchi/alteroid/actions/runs/34709221407',
};

describe('shouldAlarm', () => {
  it('main の run が failure なら鳴らす', () => {
    const result = shouldAlarm({
      conclusion: 'failure',
      headBranch: 'main',
      defaultBranch: 'main',
    });
    expect(result.alarm).toBe(true);
  });

  it('success では鳴らさない（この道具は失敗にしか反応しない）', () => {
    const result = shouldAlarm({
      conclusion: 'success',
      headBranch: 'main',
      defaultBranch: 'main',
    });
    expect(result.alarm).toBe(false);
    expect(result.reason).toContain('failure ではない');
  });

  it('PR の枝の失敗では鳴らさない —— PR の赤は PR の画面に出ている', () => {
    const result = shouldAlarm({
      conclusion: 'failure',
      headBranch: 'feat/something',
      defaultBranch: 'main',
    });
    expect(result.alarm).toBe(false);
    expect(result.reason).toContain('default branch');
  });

  it('⭐ conclusion が null（まだ終わっていない等）でも鳴らさない', () => {
    // `workflow_run` の `completed` は cancelled / skipped / null も運んでくる。
    // **「success でなければ赤」の1本判定にすると、中断や skip で Issue が生える。**
    for (const conclusion of [null, 'cancelled', 'skipped', 'neutral', 'timed_out']) {
      const result = shouldAlarm({ conclusion, headBranch: 'main', defaultBranch: 'main' });
      expect(result.alarm, `conclusion=${conclusion}`).toBe(conclusion === 'failure');
    }
  });
});
, 'm'));
  });

  it('集約ゲートの if: は always() のまま（! cancelled() や success() へ変えない —— 必須チェックが skipped になる）', () => {
    const gate = ciText.slice(ciText.search(new RegExp(`^  ${GATE_JOB_NAME}:`, 'm')));
    const ifLine = /^ {4}if: (.+)$/m.exec(gate)?.[1] ?? '';
    expect(ifLine.startsWith('always() && ')).toBe(true);
  });
});

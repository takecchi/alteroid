import { describe, expect, it } from 'vitest';

import {
  buildRecordComment,
  buildRecordLine,
  describeVerdict,
  RECORD_LINE_PREFIX,
  recordCommentMarker,
  redWorkflowNames,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './record-release-prod-ci-core.mjs';
import {
  runAlreadyMentioned,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from '../../scripts/main-ci-alarm-core.mjs';

/**
 * `record-release-prod-ci` の歯（Issue #1207 の (3)）。
 *
 * **ここは core（`record-release-prod-ci-core.mjs`）の純粋な部分だけを測る。**
 * ネットワーク（`git` / `gh`）は一切叩かない —— `check-pr-green.test.ts` /
 * `main-ci-alarm.test.ts` と同じ理由（手元は offline でありうるし、本物の
 * Issue へ書く実験はできない）。ネットワーク層（`record-release-prod-ci.mjs`
 * 自体）の検証は、この PR の報告に載せた dry-run の生出力（apply なし）で
 * 行っている。
 *
 * **下の固定値は実測を写したものである**——健全な main HEAD
 * `ecd1674e09c72b245db21b225f56ac590fd336af`（`out-of-scope`）と、本物の赤
 * `3ca63973b7dae66b48b033a962a92e19c7e73e63` / run `34709221407`
 * （`main-ci-alarm.test.ts` が使っているのと同じ実測固定値。#1207 本文の表に
 * 在る、28日で6回落ちたうち赤い区間が最長だった回）。
 */

const REAL_RED_SHA = '3ca63973b7dae66b48b033a962a92e19c7e73e63';
const REAL_RED_RUN_ID = 34709221407;
const HEALTHY_MAIN_SHA = 'ecd1674e09c72b245db21b225f56ac590fd336af';

describe('buildRecordLine', () => {
  it('verdict ごとに固定の形（release-prod-ci-record: で始まり、5つの key=value を持つ）を組み立てる', () => {
    const line = buildRecordLine({
      verdict: 'red',
      prodSha: REAL_RED_SHA,
      mainSha: REAL_RED_SHA,
      reflectOutcome: 'success',
      observedAt: '2026-09-19T01:02:03.000Z',
    });
    expect(line).toBe(
      `release-prod-ci-record: verdict=red prod_sha=${REAL_RED_SHA} main_sha=${REAL_RED_SHA} reflect=success observed_at=2026-09-19T01:02:03.000Z`,
    );
    expect(line.startsWith(RECORD_LINE_PREFIX)).toBe(true);
  });

  it.each([
    'green',
    'red',
    'cancelled',
    'out-of-scope',
    'skipped',
    'unmeasurable',
    'no-runs',
    'pending',
    'unknown',
  ])('verdict=%s でも同じ形（key=value が同じ順で並ぶ）を保つ', (verdict) => {
    const line = buildRecordLine({
      verdict,
      prodSha: 'a'.repeat(40),
      mainSha: 'b'.repeat(40),
      reflectOutcome: 'failure',
      observedAt: '2026-09-19T00:00:00.000Z',
    });
    expect(line).toMatch(
      /^release-prod-ci-record: verdict=\S+ prod_sha=\S+ main_sha=\S+ reflect=\S+ observed_at=\S+$/,
    );
    expect(line).toContain(`verdict=${verdict}`);
  });
});

describe('describeVerdict', () => {
  it('out-of-scope は「異常なし」の意味だと明記する（健全な main HEAD でも green にはならない）', () => {
    const text = describeVerdict('out-of-scope');
    expect(text).toContain('異常なし');
    expect(text).toContain(HEALTHY_MAIN_SHA);
  });

  it('red は「赤い main が本番へ出た」ことを言う', () => {
    const text = describeVerdict('red');
    expect(text).toContain('赤');
    expect(text).toContain('本番');
  });

  it('unknown は judgeSha 自体が失敗した状態を言う（out-of-scope とは別の意味）', () => {
    const text = describeVerdict('unknown');
    expect(text).not.toBe(describeVerdict('out-of-scope'));
    expect(text).toContain('判定できない');
  });

  it('未知の verdict でも例外を投げず、その旨を返す', () => {
    expect(describeVerdict('no-such-verdict')).toContain('no-such-verdict');
  });
});

describe('redWorkflowNames', () => {
  it('conclusion=failure の run の name だけを、重複を除いて返す', () => {
    const latestRuns = [
      { name: 'CI', conclusion: 'failure' },
      { name: 'release/prod へ反映', conclusion: 'success' },
      { name: 'CI', conclusion: 'failure' }, // 同名重複
    ];
    expect(redWorkflowNames(latestRuns)).toEqual(['CI']);
  });

  it('failure が無ければ空配列', () => {
    const latestRuns = [
      { name: 'CI', conclusion: 'success' },
      { name: 'image', conclusion: 'skipped' },
    ];
    expect(redWorkflowNames(latestRuns)).toEqual([]);
  });
});

describe('recordCommentMarker', () => {
  it('sha と run を埋めた HTML コメントを組み立てる', () => {
    const marker = recordCommentMarker({ sha: REAL_RED_SHA, runId: REAL_RED_RUN_ID });
    expect(marker).toBe(
      `<!-- alteroid:release-prod-ci-record sha=${REAL_RED_SHA} run=${REAL_RED_RUN_ID} -->`,
    );
  });
});

describe('buildRecordComment × runAlreadyMentioned（赤で同じ run が既出なら足さない）', () => {
  const commonInput = {
    sha: REAL_RED_SHA,
    runId: REAL_RED_RUN_ID,
    runUrl: `https://github.com/takecchi/alteroid/actions/runs/${REAL_RED_RUN_ID}`,
    verdict: 'red',
    redWorkflows: ['CI'],
    mainSha: REAL_RED_SHA,
    reflectOutcome: 'success',
    observedAt: '2026-09-19T01:02:03.000Z',
  };

  it('同じ run の記録が既に本文/コメントに在れば、runAlreadyMentioned が true を返す', () => {
    const firstComment = buildRecordComment(commonInput);
    // main-ci-alarm-core.mjs の runAlreadyMentioned は「本文＋既存コメント全部」を
    // 1つの配列として受け取る想定（decideAlarmAction と同じ形）。1回目に書いた
    // コメント自身がその texts に含まれる状況を模す。
    expect(runAlreadyMentioned([firstComment], REAL_RED_RUN_ID)).toBe(true);
  });

  it('run id が違えば既出と判定しない（同じ sha でも別の反映 run は別扱い）', () => {
    const firstComment = buildRecordComment(commonInput);
    const otherRunId = REAL_RED_RUN_ID + 1;
    expect(runAlreadyMentioned([firstComment], otherRunId)).toBe(false);
  });

  it('コメント本文は release-prod-ci-record: の記録行と recordCommentMarker の印を両方含む', () => {
    const comment = buildRecordComment(commonInput);
    expect(comment).toContain(RECORD_LINE_PREFIX);
    expect(comment).toContain(recordCommentMarker({ sha: REAL_RED_SHA, runId: REAL_RED_RUN_ID }));
    expect(comment).toContain('門ではない');
  });
});

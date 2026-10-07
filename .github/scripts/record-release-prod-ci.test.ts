import { describe, expect, it } from 'vitest';

import {
  buildRecordComment,
  buildRecordLine,
  describeVerdict,
  healthOf,
  RECORD_LINE_PREFIX,
  recordCommentMarker,
  redWorkflowNames,
  refineVerdictForCancelledRuns,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './record-release-prod-ci-core.mjs';
import {
  runAlreadyMentioned,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from '../../scripts/main-ci-alarm-core.mjs';

const REAL_RED_SHA = '3ca63973b7dae66b48b033a962a92e19c7e73e63';
const REAL_RED_RUN_ID = 34709221407;
const HEALTHY_MAIN_SHA = 'ecd1674e09c72b245db21b225f56ac590fd336af';

describe('buildRecordLine', () => {
  it('verdict ごとに固定の形（release-prod-ci-record: で始まり、6つの key=value を持つ）を組み立てる', () => {
    const line = buildRecordLine({
      verdict: 'red',
      prodSha: REAL_RED_SHA,
      mainSha: REAL_RED_SHA,
      reflectOutcome: 'success',
      observedAt: '2026-09-19T01:02:03.000Z',
    });
    expect(line).toBe(
      `release-prod-ci-record: verdict=red health=bad prod_sha=${REAL_RED_SHA} main_sha=${REAL_RED_SHA} reflect=success observed_at=2026-09-19T01:02:03.000Z`,
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
      /^release-prod-ci-record: verdict=\S+ health=(?:ok|bad|unknown) prod_sha=\S+ main_sha=\S+ reflect=\S+ observed_at=\S+$/,
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
      { name: 'CI', conclusion: 'failure' },
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

describe('healthOf（verdict を健全さの3値へ畳む）', () => {
  it('⭐ 健全な夜の2つ（green / out-of-scope）はどちらも ok', () => {
    expect(healthOf('green')).toBe('ok');
    expect(healthOf('out-of-scope')).toBe('ok');
  });

  it('赤い main が本番へ出た夜だけ bad', () => {
    expect(healthOf('red')).toBe('bad');
  });

  it('判定に至れなかったものは、ok にも bad にも畳まず unknown（取れない軸に値を作らない）', () => {
    for (const v of ['cancelled', 'skipped', 'unmeasurable', 'no-runs', 'pending', 'unknown']) {
      expect(healthOf(v)).toBe('unknown');
    }
  });

  it('知らない verdict も unknown へ落ちる（緑にも赤にも化けない）', () => {
    expect(healthOf('なにか新しい値')).toBe('unknown');
  });
});

describe('記録行の health= 欄', () => {
  const base = {
    prodSha: 'a'.repeat(40),
    mainSha: 'b'.repeat(40),
    reflectOutcome: 'success',
    observedAt: '2026-09-20T21:30:00.000Z',
  };

  it('⭐ 健全な夜（out-of-scope）の行が、行だけで健全と読める', () => {
    const line = buildRecordLine({ ...base, verdict: 'out-of-scope' });
    expect(line).toContain('verdict=out-of-scope');
    expect(line).toContain('health=ok');
  });

  it('⛔ verdict= の値そのものは1文字も変えていない（過去の記録の grep を壊さない）', () => {
    for (const v of ['green', 'red', 'out-of-scope', 'pending', 'no-runs']) {
      expect(buildRecordLine({ ...base, verdict: v })).toContain(`verdict=${v}`);
    }
    expect(buildRecordLine({ ...base, verdict: 'red' }).startsWith(RECORD_LINE_PREFIX)).toBe(true);
  });

  it('health= は verdict= の直後に置く（key=value の順が verdict ごとに揺れない）', () => {
    for (const v of ['green', 'red', 'out-of-scope', 'pending']) {
      expect(buildRecordLine({ ...base, verdict: v })).toContain(
        `verdict=${v} health=${healthOf(v)} prod_sha=`,
      );
    }
  });
});

describe('refineVerdictForCancelledRuns（取り消された CI の red を cancelled へ倒す。Issue #3049）', () => {
  const run = (id: number, name = 'CI') => ({ id, name });
  const job = (name: string, conclusion: string) => ({ name, conclusion });
  const CANCELLED_CI = [
    job('checks', 'cancelled'),
    job('test (1/2)', 'cancelled'),
    job('test (2/2)', 'cancelled'),
    job('image', 'success'),
    job('ci', 'failure'),
  ];
  const refine = (latestRuns: unknown, jobsByRunId: unknown, verdict = 'red') =>
    refineVerdictForCancelledRuns({ verdict, latestRuns, jobsByRunId });

  it('⭐ run 37372223779 型は cancelled（health=unknown）になり、green にも red にもならない', () => {
    const verdict = refine([run(37372223779)], { 37372223779: CANCELLED_CI });
    expect(verdict).toBe('cancelled');
    expect(verdict).not.toBe('green');
    expect(verdict).not.toBe('red');
    expect(healthOf(verdict)).toBe('unknown');
  });

  it('本物の失敗（test が failure、ゲートも failure）は red のまま', () => {
    const jobs = [job('checks', 'success'), job('test (1/2)', 'failure'), job('ci', 'failure')];
    expect(refine([run(1)], { 1: jobs })).toBe('red');
  });

  it('⭐ 本物の失敗が cancelled と混ざっていれば red のまま', () => {
    const jobs = [job('checks', 'failure'), job('test (1/2)', 'cancelled'), job('ci', 'failure')];
    expect(refine([run(1)], { 1: jobs })).toBe('red');
  });

  it('timed_out は red のまま', () => {
    const jobs = [job('checks', 'timed_out'), job('test (1/2)', 'cancelled'), job('ci', 'failure')];
    expect(refine([run(1)], { 1: jobs })).toBe('red');
  });

  it('別の workflow の run に本物の失敗が在れば red のまま', () => {
    expect(refine([run(1), run(2, 'Other')], { 1: CANCELLED_CI, 2: [job('x', 'failure')] })).toBe(
      'red',
    );
  });

  it('別の workflow の run の jobs を取れていなければ red のまま', () => {
    expect(refine([run(1), run(2, 'Other')], { 1: CANCELLED_CI })).toBe('red');
  });

  it('⭐ jobs が取れない（無い・null・空）ときは今までどおり red（取り消しと見なさない）', () => {
    expect(refine([run(1)], {})).toBe('red');
    expect(refine([run(1)], null)).toBe('red');
    expect(refine([run(1)], { 1: [] })).toBe('red');
  });

  it('red 以外の verdict には触らない', () => {
    for (const verdict of ['green', 'out-of-scope', 'cancelled', 'pending', 'unknown']) {
      expect(refine([run(1)], { 1: CANCELLED_CI }, verdict)).toBe(verdict);
    }
  });
});

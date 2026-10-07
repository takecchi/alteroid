import { describe, expect, it } from 'vitest';

import {
  evaluatePrGreen,
  pickLatestRunPerWorkflow,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-green-core.mjs';

describe('PR #1778 の残存する open-side の疑い（rerun の run_started_at 自体がキュー待ちで遅れる）', () => {
  it('rerun がキューで長く待たされ、別run（失敗）の作成日時を追い越すと green になる', () => {
    const queuedRerun = {
      id: 500,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 2,
      created_at: '2026-09-20T10:00:00Z',
      run_started_at: '2026-09-20T10:35:00Z',
      updated_at: '2026-09-20T10:36:00Z',
      status: 'completed',
      conclusion: 'success',
    };
    const earlierGenuineFailure = {
      id: 501,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 1,
      created_at: '2026-09-20T10:20:00Z',
      updated_at: '2026-09-20T10:22:00Z',
      status: 'completed',
      conclusion: 'failure',
    };

    expect(Date.parse(earlierGenuineFailure.created_at)).toBeLessThan(
      Date.parse(queuedRerun.run_started_at),
    );
    expect(Date.parse(earlierGenuineFailure.updated_at)).toBeLessThan(
      Date.parse(queuedRerun.run_started_at),
    );
    expect(Date.parse(earlierGenuineFailure.created_at)).toBeGreaterThan(
      Date.parse(queuedRerun.created_at),
    );

    const latest = pickLatestRunPerWorkflow([queuedRerun, earlierGenuineFailure]);

    const jobsByRunId = {
      500: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      501: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);

    expect(result.verdict).not.toBe('green');
  });
});

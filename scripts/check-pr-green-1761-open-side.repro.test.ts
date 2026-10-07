import { describe, expect, it } from 'vitest';

import {
  evaluatePrGreen,
  pickLatestRunPerWorkflow,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-green-core.mjs';

describe('PR #1761 の open-side の疑い（rerun の updated_at が別 run の created_at を追い越す）', () => {
  it('古い run を rerun して成功させると、あとから作られた別 run の failure より新しく見えて green になる', () => {
    const rerunnedOldRun = {
      id: 500,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 2,
      created_at: '2026-09-20T10:00:00Z',
      updated_at: '2026-09-20T10:40:00Z',
      status: 'completed',
      conclusion: 'success',
    };
    const genuinelyNewerFailure = {
      id: 501,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 1,
      created_at: '2026-09-20T10:20:00Z',
      updated_at: '2026-09-20T10:20:30Z',
      status: 'completed',
      conclusion: 'failure',
    };

    expect(Date.parse(genuinelyNewerFailure.created_at)).toBeGreaterThan(
      Date.parse(rerunnedOldRun.created_at),
    );

    const latest = pickLatestRunPerWorkflow([rerunnedOldRun, genuinelyNewerFailure]);

    expect(latest).toHaveLength(1);

    const jobsByRunId = {
      500: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      501: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    };

    const result = evaluatePrGreen(latest, jobsByRunId);

    expect(result.verdict).not.toBe('green');
  });
});

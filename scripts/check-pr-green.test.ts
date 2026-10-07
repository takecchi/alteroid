import { describe, expect, it } from 'vitest';

import {
  evaluatePrGreen,
  filterRunsByEvent,
  formatVerdict,
  isFullCommitSha,
  pickLatestRunPerWorkflow,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-green-core.mjs';

describe('pickLatestRunPerWorkflow', () => {
  it('#933 の実例: draft世代とready世代が同居しても、created_atで新しいほうを選ぶ', () => {
    const runs = [
      {
        id: 34743503505,
        name: 'CI',
        created_at: '2026-09-13T06:44:48Z',
        status: 'completed',
        conclusion: 'skipped',
      },
      {
        id: 34743508004,
        name: 'CI',
        created_at: '2026-09-13T06:44:54Z',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    expect(latest).toEqual([
      {
        id: 34743508004,
        name: 'CI',
        created_at: '2026-09-13T06:44:54Z',
        status: 'completed',
        conclusion: 'success',
      },
    ]);
  });

  it('created_at が同秒でも、runの id（jobのidではない）で新しいほうを選ぶ', () => {
    const older = {
      id: 100,
      name: 'CI',
      created_at: '2026-09-13T06:44:54Z',
      status: 'completed',
      conclusion: 'skipped',
    };
    const newer = {
      id: 101,
      name: 'CI',
      created_at: '2026-09-13T06:44:54Z',
      status: 'completed',
      conclusion: 'success',
    };
    expect(pickLatestRunPerWorkflow([older, newer])).toEqual([newer]);
    expect(pickLatestRunPerWorkflow([newer, older])).toEqual([newer]);
  });

  it('Issue #1225 の実例: 同じsha に同じ名前の push run と schedule run が同居しても、pushの run を落とさない', () => {
    const runs = [
      {
        id: 34709221407,
        name: 'CI',
        event: 'push',
        created_at: '2026-09-12T17:46:25Z',
        status: 'completed',
        conclusion: 'failure',
      },
      {
        id: 34709324541,
        name: 'CI',
        event: 'schedule',
        created_at: '2026-09-12T17:48:26Z',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    expect(latest.map((r: { id: number }) => r.id).sort((a: number, b: number) => a - b)).toEqual([
      34709221407, 34709324541,
    ]);

    const jobsByRunId = {
      34709221407: [
        { name: 'ci', status: 'completed', conclusion: 'failure' },
        { name: 'pr-origin', status: 'completed', conclusion: 'skipped' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
      34709324541: [
        { name: 'ci', status: 'completed', conclusion: 'skipped' },
        { name: 'pr-origin', status: 'completed', conclusion: 'skipped' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('red');
    expect(
      result.detail.some(
        (line: string) =>
          line.includes('ci') && line.includes('failure') && line.includes('34709221407'),
      ),
    ).toBe(true);
  });

  it('別workflowの実例（Issue #933コメント、virchamate PR #564）: 複数workflowを両方とも残す', () => {
    const runs = [
      {
        id: 34744307932,
        name: 'Test Backend',
        created_at: '2026-09-13T07:04:06Z',
        status: 'in_progress',
        conclusion: null,
      },
      {
        id: 34744308153,
        name: 'Guardrail Check',
        created_at: '2026-09-13T07:04:07Z',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    expect(latest.map((r: { name: string }) => r.name)).toEqual([
      'Guardrail Check',
      'Test Backend',
    ]);
    const testBackend = latest.find((r: { name: string }) => r.name === 'Test Backend');
    expect(testBackend?.status).toBe('in_progress');
  });

  it('#933 コメントの追加実測（PR #997、sha 5de558f6b2ca5e89ed2efac7b8d677f56cabb879）: jobの completed_at が started_at より前でも、run自身の created_at で新しいほうを選ぶ', () => {
    const runs = [
      {
        id: 34929697970,
        name: 'CI',
        created_at: '2026-09-15T04:39:56Z',
        status: 'completed',
        conclusion: 'skipped',
      },
      {
        id: 34929744708,
        name: 'CI',
        created_at: '2026-09-15T04:40:39Z',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    expect(latest).toEqual([
      {
        id: 34929744708,
        name: 'CI',
        created_at: '2026-09-15T04:40:39Z',
        status: 'completed',
        conclusion: 'success',
      },
    ]);

    const jobsByRunId = {
      34929744708: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'base-overlap', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('green');
  });

  it('Issue #1748 の実例: rerun が絡み結論も食い違うので、15回目の横断レビュー以降は「判定できない」（undecidable-rerun-conflict）と言う（反転）', () => {
    const draftOriginSkip = {
      id: 36286928087,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 1,
      created_at: '2026-09-27T01:54:11Z',
      updated_at: '2026-09-27T01:54:22Z',
      status: 'completed',
      conclusion: 'skipped',
    };
    const rerunSuccess = {
      id: 36286927781,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 2,
      created_at: '2026-09-27T01:54:10Z',
      run_started_at: '2026-09-27T02:02:08Z',
      updated_at: '2026-09-27T02:16:15Z',
      status: 'completed',
      conclusion: 'success',
    };

    expect(Date.parse(draftOriginSkip.created_at)).toBeGreaterThan(
      Date.parse(rerunSuccess.created_at),
    );
    expect(Date.parse(rerunSuccess.run_started_at)).toBeGreaterThan(
      Date.parse(draftOriginSkip.created_at),
    );

    const latest = pickLatestRunPerWorkflow([draftOriginSkip, rerunSuccess]);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBeNull();
    expect(latest[0].rerunConflict).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: draftOriginSkip.id, conclusion: 'skipped' }),
        expect.objectContaining({ id: rerunSuccess.id, conclusion: 'success' }),
      ]),
    );
    expect(pickLatestRunPerWorkflow([rerunSuccess, draftOriginSkip])).toEqual(latest);

    const jobsByRunId = {
      36286927781: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('undecidable-rerun-conflict');
    expect(result.detail.some((line: string) => line.includes('mergeStateStatus'))).toBe(true);
    expect(result.detail.some((line: string) => line.includes(String(draftOriginSkip.id)))).toBe(
      true,
    );
    expect(result.detail.some((line: string) => line.includes(String(rerunSuccess.id)))).toBe(true);
  });

  it('Issue #1748 の変異ガード: run_attempt を無視して常に created_at で選ぶと、#1748 の標本は再び skipped（NG）に戻る', () => {
    const draftOriginSkip = {
      id: 36286928087,
      name: 'CI',
      created_at: '2026-09-27T01:54:11Z',
      conclusion: 'skipped',
    };
    const rerunSuccess = {
      id: 36286927781,
      name: 'CI',
      created_at: '2026-09-27T01:54:10Z',
      conclusion: 'success',
    };
    const naiveNewerByCreatedAtOnly = (a: typeof draftOriginSkip, b: typeof rerunSuccess) => {
      const ta = Date.parse(a.created_at);
      const tb = Date.parse(b.created_at);
      if (ta !== tb) return ta > tb ? a : b;
      return a.id > b.id ? a : b;
    };
    expect(naiveNewerByCreatedAtOnly(draftOriginSkip, rerunSuccess)).toEqual(draftOriginSkip);
  });

  it('Issue #1761 の open-side の疑い（14回目の横断レビュー、wip/review14-s5 の再現テスト由来）: rerun の run_started_at が、別の genuinely 新しい run の created_at より前なら、その別 run の failure を隠さない', () => {
    const rerunnedOldRun = {
      id: 500,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 2,
      created_at: '2026-09-20T10:00:00Z',
      run_started_at: '2026-09-20T10:05:00Z',
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

    expect(Date.parse(rerunnedOldRun.run_started_at)).toBeLessThan(
      Date.parse(genuinelyNewerFailure.created_at),
    );
    expect(Date.parse(rerunnedOldRun.updated_at)).toBeGreaterThan(
      Date.parse(genuinelyNewerFailure.created_at),
    );

    const latest = pickLatestRunPerWorkflow([rerunnedOldRun, genuinelyNewerFailure]);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBeNull();
    expect(latest[0].rerunConflict).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: rerunnedOldRun.id, conclusion: 'success' }),
        expect.objectContaining({ id: genuinelyNewerFailure.id, conclusion: 'failure' }),
      ]),
    );

    const jobsByRunId = {
      500: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      501: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).not.toBe('green');
    expect(result.verdict).toBe('undecidable-rerun-conflict');
  });

  it('鏡像: rerun の run_started_at が、別の run の created_at より後でも、conclusion が食い違うなら15回目の横断レビュー以降は判定できない（反転）', () => {
    const otherRun = {
      id: 501,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 1,
      created_at: '2026-09-20T10:20:00Z',
      updated_at: '2026-09-20T10:20:30Z',
      status: 'completed',
      conclusion: 'failure',
    };
    const rerunnedNewerRun = {
      id: 500,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 2,
      created_at: '2026-09-20T10:00:00Z',
      run_started_at: '2026-09-20T10:25:00Z',
      updated_at: '2026-09-20T10:40:00Z',
      status: 'completed',
      conclusion: 'success',
    };

    expect(Date.parse(rerunnedNewerRun.run_started_at)).toBeGreaterThan(
      Date.parse(otherRun.created_at),
    );

    const latest = pickLatestRunPerWorkflow([otherRun, rerunnedNewerRun]);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBeNull();
    expect(latest[0].rerunConflict).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: otherRun.id, conclusion: 'failure' }),
        expect.objectContaining({ id: rerunnedNewerRun.id, conclusion: 'success' }),
      ]),
    );

    const jobsByRunId = {
      500: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      501: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('undecidable-rerun-conflict');
  });

  it('PR #1801 レビュー: rerun が絡む鍵に未完了の run が混じると、時刻では選ばず pending になる（green ではない）', () => {
    const rerunnedQueuedRun = {
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
    const stillRunningNewerRun = {
      id: 502,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 1,
      created_at: '2026-09-20T10:20:00Z',
      status: 'in_progress',
      conclusion: null,
    };

    expect(Date.parse(rerunnedQueuedRun.run_started_at)).toBeGreaterThan(
      Date.parse(stillRunningNewerRun.created_at),
    );

    const latest = pickLatestRunPerWorkflow([rerunnedQueuedRun, stillRunningNewerRun]);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe(stillRunningNewerRun.id);
    expect(latest[0].status).toBe('in_progress');

    const jobsByRunId = {
      500: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('pending');
    expect(result.verdict).not.toBe('green');
  });

  describe('Issue #2209: ジョブが1本も走っていない run を、rerun の食い違い判定より前に外す', () => {
    it('(a) Issue #2175 の実データ: draft 由来のジョブ0本 run を外すと green になる（実測 2026-09-29、sha 1e28808e5b6f2d1d0b2c39d6122ab0ab2cd61dbb）', () => {
      const draftSkipped = {
        id: 36563936180,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T05:57:00Z',
        status: 'completed',
        conclusion: 'skipped',
      };
      const rerunSuccess = {
        id: 36564163120,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 2,
        created_at: '2026-09-29T05:40:00Z',
        run_started_at: '2026-09-29T06:10:00Z',
        status: 'completed',
        conclusion: 'success',
      };
      const jobsByRunId = {
        36563936180: [
          { name: 'image', status: 'completed', conclusion: 'skipped' },
          { name: 'ci', status: 'completed', conclusion: 'skipped' },
        ],
        36564163120: [
          { name: 'image', status: 'completed', conclusion: 'success' },
          { name: 'ci', status: 'completed', conclusion: 'success' },
        ],
      };

      const latest = pickLatestRunPerWorkflow([draftSkipped, rerunSuccess], jobsByRunId);
      expect(latest).toEqual([rerunSuccess]);

      const result = evaluatePrGreen(latest, jobsByRunId);
      expect(result.verdict).toBe('green');
    });

    it('(b) draft 由来の skip を外しても、走った run が failure なら red のまま', () => {
      const draftSkipped = {
        id: 1,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T00:00:00Z',
        status: 'completed',
        conclusion: 'skipped',
      };
      const readyFailure = {
        id: 2,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T00:10:00Z',
        status: 'completed',
        conclusion: 'failure',
      };
      const jobsByRunId = {
        1: [
          { name: 'image', status: 'completed', conclusion: 'skipped' },
          { name: 'ci', status: 'completed', conclusion: 'skipped' },
        ],
        2: [
          { name: 'image', status: 'completed', conclusion: 'success' },
          { name: 'ci', status: 'completed', conclusion: 'failure' },
        ],
      };
      const latest = pickLatestRunPerWorkflow([draftSkipped, readyFailure], jobsByRunId);
      expect(latest).toEqual([readyFailure]);
      const result = evaluatePrGreen(latest, jobsByRunId);
      expect(result.verdict).toBe('red');
    });

    it('(c) draft 由来の skip を外しても、走った run 同士が食い違えば undecidable-rerun-conflict のまま', () => {
      const draftSkipped = {
        id: 1,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T00:00:00Z',
        status: 'completed',
        conclusion: 'skipped',
      };
      const genuineFailure = {
        id: 2,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T00:05:00Z',
        status: 'completed',
        conclusion: 'failure',
      };
      const rerunSuccess = {
        id: 3,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 2,
        created_at: '2026-09-29T00:02:00Z',
        run_started_at: '2026-09-29T00:20:00Z',
        status: 'completed',
        conclusion: 'success',
      };
      const jobsByRunId = {
        1: [{ name: 'ci', status: 'completed', conclusion: 'skipped' }],
        2: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
        3: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      };
      const latest = pickLatestRunPerWorkflow(
        [draftSkipped, genuineFailure, rerunSuccess],
        jobsByRunId,
      );
      expect(latest).toHaveLength(1);
      expect(latest[0].id).toBeNull();
      expect(latest[0].rerunConflict).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: genuineFailure.id, conclusion: 'failure' }),
          expect.objectContaining({ id: rerunSuccess.id, conclusion: 'success' }),
        ]),
      );
      expect(latest[0].rerunConflict.some((x: { id: number }) => x.id === draftSkipped.id)).toBe(
        false,
      );

      const result = evaluatePrGreen(latest, jobsByRunId);
      expect(result.verdict).toBe('undecidable-rerun-conflict');
    });

    it('(d) 鍵の全部がジョブの走っていない run なら、今までどおり時刻で選ぶ（除外は起きない）', () => {
      const olderAllSkipped = {
        id: 1,
        name: 'CI',
        event: 'schedule',
        run_attempt: 1,
        created_at: '2026-09-29T00:00:00Z',
        status: 'completed',
        conclusion: 'skipped',
      };
      const newerAllSkipped = {
        id: 2,
        name: 'CI',
        event: 'schedule',
        run_attempt: 1,
        created_at: '2026-09-29T00:10:00Z',
        status: 'completed',
        conclusion: 'skipped',
      };
      const jobsByRunId = {
        1: [{ name: 'ci', status: 'completed', conclusion: 'skipped' }],
        2: [{ name: 'ci', status: 'completed', conclusion: 'skipped' }],
      };
      const withJobs = pickLatestRunPerWorkflow([olderAllSkipped, newerAllSkipped], jobsByRunId);
      const withoutJobs = pickLatestRunPerWorkflow([olderAllSkipped, newerAllSkipped]);
      expect(withJobs).toEqual([newerAllSkipped]);
      expect(withoutJobs).toEqual([newerAllSkipped]);
    });

    it('(e) jobs が取れなかった（jobsByRunId に無い）run は外さない —— 開く側へ倒れない', () => {
      const unknownJobsRun = {
        id: 1,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T00:00:00Z',
        status: 'completed',
        conclusion: 'skipped',
      };
      const rerunSuccess = {
        id: 2,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 2,
        created_at: '2026-09-29T00:05:00Z',
        run_started_at: '2026-09-29T00:20:00Z',
        status: 'completed',
        conclusion: 'success',
      };
      const jobsByRunId = {
        2: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      };
      const latest = pickLatestRunPerWorkflow([unknownJobsRun, rerunSuccess], jobsByRunId);
      expect(latest).toHaveLength(1);
      expect(latest[0].id).toBeNull();
      expect(latest[0].rerunConflict).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: unknownJobsRun.id, conclusion: 'skipped' }),
          expect.objectContaining({ id: rerunSuccess.id, conclusion: 'success' }),
        ]),
      );
    });

    it('(f) jobs の一部だけが skipped の run（一部は走った）は外さない', () => {
      const partiallySkipped = {
        id: 1,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T00:00:00Z',
        status: 'completed',
        conclusion: 'failure',
      };
      const rerunSuccess = {
        id: 2,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 2,
        created_at: '2026-09-29T00:05:00Z',
        run_started_at: '2026-09-29T00:20:00Z',
        status: 'completed',
        conclusion: 'success',
      };
      const jobsByRunId = {
        1: [
          { name: 'image', status: 'completed', conclusion: 'skipped' },
          { name: 'ci', status: 'completed', conclusion: 'failure' },
        ],
        2: [
          { name: 'image', status: 'completed', conclusion: 'success' },
          { name: 'ci', status: 'completed', conclusion: 'success' },
        ],
      };
      const latest = pickLatestRunPerWorkflow([partiallySkipped, rerunSuccess], jobsByRunId);
      expect(latest).toHaveLength(1);
      expect(latest[0].id).toBeNull();
      expect(latest[0].rerunConflict).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: partiallySkipped.id, conclusion: 'failure' }),
          expect.objectContaining({ id: rerunSuccess.id, conclusion: 'success' }),
        ]),
      );
    });
  });
});

describe('evaluatePrGreen', () => {
  const latestRuns = [
    {
      id: 34743508004,
      name: 'CI',
      created_at: '2026-09-13T06:44:54Z',
      status: 'completed',
      conclusion: 'success',
    },
  ];

  it('#933 の実例がそのまま green になる（4ジョブ、base-overlap を含めすべて success）', () => {
    const jobsByRunId = {
      34743508004: [
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'base-overlap', status: 'completed', conclusion: 'success' },
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'pr-origin', status: 'completed', conclusion: 'success' },
      ],
    };
    const result = evaluatePrGreen(latestRuns, jobsByRunId);
    expect(result.verdict).toBe('green');
    expect(result.detail.some((line: string) => line.includes('base-overlap'))).toBe(true);
  });

  it('run が1つも無い sha は no-runs（緑ではない）', () => {
    expect(evaluatePrGreen([], {}).verdict).toBe('no-runs');
  });

  it('最新runがまだ completed でなければ pending', () => {
    const running = [
      {
        id: 1,
        name: 'CI',
        created_at: '2026-09-15T00:00:00Z',
        status: 'in_progress',
        conclusion: null,
      },
    ];
    const result = evaluatePrGreen(running, {});
    expect(result.verdict).toBe('pending');
  });

  it('jobsが0件のrunは unmeasurable（AGENTS.mdの「ジョブ0本のrunは何も言っていない」と同じ扱い）', () => {
    const result = evaluatePrGreen(latestRuns, { 34743508004: [] });
    expect(result.verdict).toBe('unmeasurable');
  });

  it('success以外のjobが1つでもあれば red', () => {
    const jobsByRunId = {
      34743508004: [
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'ci', status: 'completed', conclusion: 'failure' },
      ],
    };
    const result = evaluatePrGreen(latestRuns, jobsByRunId);
    expect(result.verdict).toBe('red');
    expect(
      result.detail.some((line: string) => line.includes('ci') && line.includes('failure')),
    ).toBe(true);
  });

  it('Issue #1197 の再現: pushのrun（マージ直後のmain）で ci=success/image=success/base-overlap=skipped は out-of-scope（NGではない）', () => {
    const runs = [
      {
        id: 1,
        name: 'CI',
        event: 'push',
        created_at: '2026-09-17T12:00:00Z',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('out-of-scope');
    expect(result.detail.some((line: string) => line.includes('base-overlap'))).toBe(true);
  });

  it('out-of-scopeの標本にciのfailureが混じると red になる（out-of-scopeが赤を隠さない）', () => {
    const runs = [
      {
        id: 1,
        name: 'CI',
        event: 'push',
        created_at: '2026-09-17T12:00:00Z',
        status: 'completed',
        conclusion: 'failure',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'failure' },
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('red');
  });

  it('pull_requestのrunで ci=skipped は skipped（draftのtrap。緑にもout-of-scopeにもしない）', () => {
    const runs = [
      {
        id: 1,
        name: 'CI',
        event: 'pull_request',
        created_at: '2026-09-17T12:00:00Z',
        status: 'completed',
        conclusion: 'skipped',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'skipped' },
        { name: 'image', status: 'completed', conclusion: 'skipped' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('skipped');
  });

  it('cancelledだけが在れば cancelled（赤ではない）', () => {
    const jobsByRunId = {
      34743508004: [
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'ci', status: 'completed', conclusion: 'cancelled' },
      ],
    };
    const result = evaluatePrGreen(latestRuns, jobsByRunId);
    expect(result.verdict).toBe('cancelled');
  });

  it('failureとcancelledが同居すると red（cancelledがredを隠さない）', () => {
    const jobsByRunId = {
      34743508004: [
        { name: 'image', status: 'completed', conclusion: 'failure' },
        { name: 'ci', status: 'completed', conclusion: 'cancelled' },
      ],
    };
    const result = evaluatePrGreen(latestRuns, jobsByRunId);
    expect(result.verdict).toBe('red');
  });

  it('pushのrunで全jobがskippedなら unmeasurable（out-of-scopeと名乗らない。scheduleでの偽の安心を防ぐ詰め）', () => {
    const runs = [
      {
        id: 1,
        name: 'CI',
        event: 'push',
        created_at: '2026-09-17T12:00:00Z',
        status: 'completed',
        conclusion: 'skipped',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'skipped' },
        { name: 'image', status: 'completed', conclusion: 'skipped' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('unmeasurable');
  });

  it('eventが無いrunでskippedが在れば skipped（安全側。out-of-scopeを名乗らない）', () => {
    const runs = [
      {
        id: 1,
        name: 'CI',
        created_at: '2026-09-17T12:00:00Z',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('skipped');
  });

  it('鏡像ケース: 古い世代のsuccessが新しい世代のfailureに引きずられない', () => {
    const runs = [
      {
        id: 1,
        name: 'CI',
        created_at: '2026-09-15T00:00:00Z',
        status: 'completed',
        conclusion: 'success',
      },
      {
        id: 2,
        name: 'CI',
        created_at: '2026-09-15T00:00:10Z',
        status: 'completed',
        conclusion: 'failure',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    const jobsByRunId = {
      2: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('red');
  });
});

describe('formatVerdict', () => {
  it('各verdictの1行目に判定の種類が読める（静かに失敗しない）', () => {
    expect(formatVerdict('abc123', { verdict: 'green', detail: [] })).toMatch(/OK/);
    expect(formatVerdict('abc123', { verdict: 'red', detail: [] })).toMatch(/NG/);
    expect(formatVerdict('abc123', { verdict: 'pending', detail: [] })).toMatch(/保留/);
    expect(formatVerdict('abc123', { verdict: 'unmeasurable', detail: [] })).toMatch(
      /判定できなかった/,
    );
    expect(formatVerdict('abc123', { verdict: 'no-runs', detail: [] })).toMatch(/判定できなかった/);
    expect(formatVerdict('abc123', { verdict: 'cancelled', detail: [] })).toMatch(/中断された job/);
    expect(formatVerdict('abc123', { verdict: 'out-of-scope', detail: [] })).toMatch(/対象外/);
    expect(formatVerdict('abc123', { verdict: 'skipped', detail: [] })).toMatch(/draft/);
  });
});

describe('filterRunsByEvent（Issue #1207 の (3) 自己参照バグの修正）', () => {
  it('events を渡さなければ（既定）1件も落とさない —— 既存の呼び出し元の挙動を変えない', () => {
    const runs = [
      { id: 1, name: 'CI', event: 'push' },
      { id: 2, name: 'release/prod へ反映', event: 'schedule' },
      { id: 3, name: '名前無し互換', event: undefined },
    ];
    expect(filterRunsByEvent(runs, undefined)).toEqual(runs);
    expect(filterRunsByEvent(runs, null)).toEqual(runs);
  });

  it('events=["push"] を渡すと、push 以外（schedule / workflow_dispatch / workflow_run）を落とす', () => {
    const runs = [
      { id: 1, name: 'CI', event: 'push' },
      { id: 2, name: 'release/prod へ反映', event: 'schedule' },
      { id: 3, name: 'release/prod へ反映', event: 'workflow_dispatch' },
      { id: 4, name: 'main の赤を知らせる', event: 'workflow_run' },
    ];
    expect(filterRunsByEvent(runs, ['push']).map((r: { id: number }) => r.id)).toEqual([1]);
  });

  it('空配列を渡すと全部落ちる（何も許可しない、という指定として扱う）', () => {
    const runs = [{ id: 1, name: 'CI', event: 'push' }];
    expect(filterRunsByEvent(runs, [])).toEqual([]);
  });
});

describe('自己参照バグの再現と修正（Issue #1207 の (3)。実測固定値）', () => {
  const runs = [
    {
      id: 35458661938,
      name: 'CI',
      event: 'push',
      created_at: '2026-09-19T17:37:24Z',
      status: 'completed',
      conclusion: 'success',
    },
    {
      id: 35470533724,
      name: 'release/prod へ反映',
      event: 'schedule',
      created_at: '2026-09-19T21:28:49Z',
      status: 'in_progress',
      conclusion: null,
    },
  ];
  const jobsByRunId = {
    35458661938: [
      { name: 'ci', status: 'completed', conclusion: 'success' },
      { name: 'image', status: 'completed', conclusion: 'success' },
      { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
    ],
  };

  it('絞らない（旧来の挙動）: 実行中の自分自身が latestRuns に混ざり、pending に化ける', () => {
    const latest = pickLatestRunPerWorkflow(filterRunsByEvent(runs, undefined));
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('pending');
    expect(result.detail.join('\n')).toContain('release/prod へ反映');
  });

  it('events=["push"] で絞る（修正後）: 自己参照が構造的に外れ、push の CI run だけで判定できる', () => {
    const latest = pickLatestRunPerWorkflow(filterRunsByEvent(runs, ['push']));
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('out-of-scope');
  });
});

describe('isFullCommitSha（略記を no-runs に化けさせないための述語。Issue #1192 の N5）', () => {
  it('40文字の16進だけを真とする（大文字も可）', () => {
    expect(isFullCommitSha('3ca63973b7dae66b48b033a962a92e19c7e73e63')).toBe(true);
    expect(isFullCommitSha('3CA63973B7DAE66B48B033A962A92E19C7E73E63')).toBe(true);
  });

  it('略記・長すぎ・非16進・sha でない型は偽', () => {
    expect(isFullCommitSha('3ca63973b7da')).toBe(false);
    expect(isFullCommitSha('f'.repeat(39))).toBe(false);
    expect(isFullCommitSha('f'.repeat(41))).toBe(false);
    expect(isFullCommitSha('g'.repeat(40))).toBe(false);
    expect(isFullCommitSha('')).toBe(false);
    expect(isFullCommitSha(undefined)).toBe(false);
    expect(isFullCommitSha(12345)).toBe(false);
  });
});

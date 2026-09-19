import { describe, expect, it } from 'vitest';

import {
  evaluatePrGreen,
  filterRunsByEvent,
  formatVerdict,
  pickLatestRunPerWorkflow,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-green-core.mjs';

/**
 * `check-pr-green` の歯（Issue #933）。
 *
 * 本物の `gh api` は叩かない —— 合成した応答で判定だけを確かめる
 * （`check-required-status-checks.test.ts` と同じ理由。手元は offline で
 * ありうるし、CI から見た本物の GitHub 状態は時間とともに変わる）。
 *
 * 下の「実測を写した固定値」は、`gh api
 * repos/takecchi/alteroid/commits/1e619f43858160fb5d9a6b1895d236e35d4771cf/check-runs`
 * および `gh api repos/takecchi/alteroid/actions/runs?head_sha=...` /
 * `gh api repos/takecchi/alteroid/actions/runs/<id>/jobs` を実行して得た
 * 本物の応答から必要な欄だけを抜いたものである（観測 2026-09-15、PR #932）。
 */

describe('pickLatestRunPerWorkflow', () => {
  it('#933 の実例: draft世代とready世代が同居しても、created_atで新しいほうを選ぶ', () => {
    // 実測: draft run 34743503505（06:44:48作成、conclusion=skipped）と
    // ready run 34743508004（06:44:54作成、conclusion=success）が同じ sha に同居。
    // check-runs 側の base-overlap は started_at も id も逆転していたが（Issue本文）、
    // actions/runs の created_at は run そのものの作成時刻なので逆転しない。
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
    // 実測: gh api 'repos/takecchi/alteroid/actions/runs?head_sha=3ca63973b7dae66b48b033a962a92e19c7e73e63'
    // sha 3ca63973b7dae66b48b033a962a92e19c7e73e63 に `CI` の run が2本同居した——
    // push の run 34709221407（06:46:25作成、conclusion=failure。ci=failure）と、
    // その2分後にできた schedule の run 34709324541（06:48:26作成、
    // conclusion=success。drift運転でciを丸ごとskip）。旧実装（名前だけで
    // まとめてcreated_atの新しいほうを残す）は schedule の run が push の run を
    // 追い出し、ci=failure が評価から消えて out-of-scope に化けた。
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
    // 名前だけでは1本に潰されず、event が違う2本ともが残る。
    expect(latest.map((r: { id: number }) => r.id).sort((a: number, b: number) => a - b)).toEqual([
      34709221407, 34709324541,
    ]);

    // 実測: gh api repos/takecchi/alteroid/actions/runs/<id>/jobs
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
    // 実測: 同じsha に `Test Backend`（走行中）と `Guardrail Check`（success、
    // 1ジョブだけ）という別workflowの run が同居。「run を1本だけ選ぶ」直し方は
    // Guardrail Check を選んで Test Backend を丸ごと落とす（Issueコメントの実測）。
    // workflow名ごとに選べば両方が latestRuns に残り、Test Backend の未完了が
    // pending として拾える。
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
    // 実測（観測 2026-09-15T04:40Z、UTC）: draft世代 run 34929697970 の `image`
    // job は started_at=04:40:04 completed_at=04:39:57（completed_at が7秒
    // "前"）という、started_at 単独の逆転（Issue本文）とは別の壊れ方をしていた。
    // 「started_at が駄目なら completed_at を使う」という代替案も、この実測で
    // 塞がれている —— job 側のどちらの時刻も世代の順序を決める根拠にならない。
    // この道具はそもそも job の started_at/completed_at を一度も読まない
    // （下の jobsByRunId は conclusion/status しか持たない）ので、この異常は
    // pickLatestRunPerWorkflow にも evaluatePrGreen にも一切入力されない。
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

    // 実測: gh api repos/takecchi/alteroid/actions/runs/34929744708/jobs
    // （新しい世代のjobsのみ。古い世代の image の completed_at<started_at は
    // ここには一切現れない —— pickLatestRunPerWorkflow の時点で run ごと
    // 落ちているため）
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
    // 実測: gh api repos/takecchi/alteroid/actions/runs/34743508004/jobs
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
    // 実測を模した合成標本: PR #1193 マージ後の main（939e775）で
    // pnpm check:pr-green を打つと、base-overlap（pull_request 専用）が
    // skipped のまま残り、従来の判定は NG（red）に丸めていた。
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
        // event を持たない（古い呼び出し・試験の既定を模す）
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
    // Issue #933「今回は安全側に外れたが、鏡像は古い世代のsuccessが新しい世代の
    // failureをstarted_atで追い越す」を、created_atベースの選択で再現する。
    // 古いrun（先に作られた、success）と新しいrun（後に作られた、failure）が
    // 同じworkflow名で同居しても、常に新しいほうのjobsだけを見る。
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
  // 実測（2026-09-19T21:28:57Z 観測、release-prod.yml 記録 step のログ、
  // sha fa9ec3e380fbe9dad8a3d1ad3e6c43c0639d5cb6）を写した最小構成。
  // release-prod.yml の記録 step は main HEAD の sha を judgeSha に渡すが、
  // その sha は「いま実行中の release-prod.yml 自身の run」も同じ head_sha
  // で名乗っている（schedule/workflow_dispatch は「そのとき指している
  // デフォルトブランチの先端」を head_sha に持つため）。
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
      // これが「実行するたびに自分自身を理由に pending を返す」原因——
      // まさにこの記録 step を動かしている release-prod.yml 自身の run。
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
    // push の run のみ ⟹ pull_request の run が無いので out-of-scope
    // （base-overlap は pull_request 専用で設計どおり skip。ci/image は success）。
    expect(result.verdict).toBe('out-of-scope');
  });
});

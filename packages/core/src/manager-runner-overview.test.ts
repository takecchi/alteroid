import { describe, expect, it } from 'vitest';

import type { ManagerSummary, RunnerOverview } from './manager.js';
import {
  bucketManagersByRunner,
  buildRunnerBacklog,
  buildRunnerOverview,
} from './manager-runner-overview.js';
import type { RunnerEntry } from './runner-protocol.js';

// `manager-runner-overview.ts`（`Pool#runners` から出した純関数 3 本）の入力の組み合わせ→出力を固定する。
// 値は `manager-runners-pin.test.ts`（切り出し前の `Pool#runners` を外から縛るもの）の出力と同じ形で、今の作りの出力から目で確かめたもの
// （仕様を先に書いたものではない）。純関数なので待ちは要らない。

function summary(
  managerId: string,
  runnerId: string | undefined,
  rest: Partial<ManagerSummary> = {},
): ManagerSummary {
  return {
    managerId,
    status: 'done',
    live: false,
    ...(runnerId === undefined ? {} : { runnerId }),
    // `ManagerSummary` の他の欄は、この関数が読まない（欄を足しても写らない）ことを見るために余分に載せる。
    summary: 'この欄は写らない',
    request: 'この欄も写らない',
    ...rest,
  } as ManagerSummary;
}

describe('bucketManagersByRunner', () => {
  it('runnerId の無い分は unassigned 別枠・同じ runnerId は managers の順を保つ・読まない欄は写らない', () => {
    const { byRunner, unassigned } = bucketManagersByRunner([
      summary('m1', 'runner-a'),
      summary('m2', undefined),
      summary('m3', 'runner-b'),
      summary('m4', 'runner-a', { status: 'running', live: true }),
    ]);
    expect([...byRunner.keys()]).toEqual(['runner-a', 'runner-b']);
    expect(byRunner.get('runner-a')).toEqual([
      { managerId: 'm1', status: 'done', live: false },
      { managerId: 'm4', status: 'running', live: true },
    ]);
    expect(byRunner.get('runner-b')).toEqual([{ managerId: 'm3', status: 'done', live: false }]);
    expect(unassigned).toEqual([{ managerId: 'm2', status: 'done', live: false }]);
  });

  it('live は落とさず、4 つの任意欄は undefined のとき欄ごと無く、在るとき載る', () => {
    const awaiting = { tasks: 2, withheldReports: 1, breakdown: 'local_agent×2', since: 'S' };
    const { byRunner, unassigned } = bucketManagersByRunner([
      summary('bare', 'runner-a'),
      summary('rich', 'runner-a', {
        awaitingBackground: awaiting,
        tokenGeneration: 3,
        activeTokenGeneration: 5,
        tokenGenerationUnknownReason: 'not-yet-observed',
      }),
      summary('unassigned-rich', undefined, { tokenGeneration: 0 }),
    ]);
    const [bare, rich] = byRunner.get('runner-a') ?? [];
    expect(Object.keys(bare ?? {}).sort()).toEqual(['live', 'managerId', 'status']);
    expect(rich).toEqual({
      managerId: 'rich',
      status: 'done',
      live: false,
      awaitingBackground: awaiting,
      tokenGeneration: 3,
      activeTokenGeneration: 5,
      tokenGenerationUnknownReason: 'not-yet-observed',
    });
    // 0 は「在る」: `undefined` だけを落とす。
    expect(unassigned).toEqual([
      { managerId: 'unassigned-rich', status: 'done', live: false, tokenGeneration: 0 },
    ]);
  });

  it('空の入力は空の Map と空の配列', () => {
    const { byRunner, unassigned } = bucketManagersByRunner([]);
    expect(byRunner.size).toBe(0);
    expect(unassigned).toEqual([]);
  });
});

describe('buildRunnerBacklog', () => {
  it('oldestPendingAt と instanceId が在れば載り、observedAt は渡した値のまま', () => {
    expect(
      buildRunnerBacklog(
        { runnerId: 'runner-a', instanceId: 'inst-a' },
        { pendingEvents: 3, oldestPendingAt: '2026-10-01T08:00:00.000Z' },
        '2026-10-01T09:00:00.000Z',
      ),
    ).toEqual({
      runnerId: 'runner-a',
      pendingEvents: 3,
      oldestPendingAt: '2026-10-01T08:00:00.000Z',
      observedAt: '2026-10-01T09:00:00.000Z',
      instanceIdAtObservation: 'inst-a',
    });
  });

  it('oldestPendingAt・instanceId が undefined のときは欄ごと無い。0 件は 0 のまま', () => {
    const snapshot = buildRunnerBacklog(
      { runnerId: 'runner-zero', instanceId: undefined },
      { pendingEvents: 0, oldestPendingAt: undefined },
      '2026-10-01T09:00:00.000Z',
    );
    expect(snapshot).toEqual({
      runnerId: 'runner-zero',
      pendingEvents: 0,
      observedAt: '2026-10-01T09:00:00.000Z',
    });
    expect('oldestPendingAt' in snapshot).toBe(false);
    expect('instanceIdAtObservation' in snapshot).toBe(false);
  });
});

describe('buildRunnerOverview', () => {
  const MANAGERS = [{ managerId: 'm1', status: 'done' as const, live: false }];
  const FULL_ENTRY: RunnerEntry = {
    label: 'label-a',
    state: 'connected',
    runnerId: 'runner-a',
    workspacePath: '/work/a',
    error: 'boom',
    since: '2026-09-30T00:00:00.000Z',
    instanceId: 'inst-a',
    instanceSince: '2026-09-30T12:00:00.000Z',
    revision: { status: 'known', commit: 'abcdef0123', short: 'abcdef0', source: 'build' },
  };
  const NOT_ASKED = { value: undefined, probe: undefined } as const;
  const NOTHING = {
    credentialsProbed: NOT_ASKED,
    profileProbed: NOT_ASKED,
    mcpServersProbed: NOT_ASKED,
    resourcesProbed: NOT_ASKED,
    resources: undefined,
  };
  const MIN_ENTRY: RunnerEntry = {
    label: 'runner-min',
    state: 'unreachable',
    since: '2026-09-30T00:00:00.000Z',
    revision: { status: 'unheard' },
  };

  it('最小: 必須の 5 欄（label・state・since・managers・revision）と managerPeers だけで、他は欄ごと無い', () => {
    const overview = buildRunnerOverview(MIN_ENTRY, [], NOTHING, undefined, undefined, {
      status: 'unknown',
    });
    expect(overview).toEqual({
      label: 'runner-min',
      state: 'unreachable',
      since: '2026-09-30T00:00:00.000Z',
      managers: [],
      revision: { status: 'unheard' },
      managerPeers: { status: 'unknown' },
    });
    expect(Object.keys(overview).sort()).toEqual([
      'label',
      'managerPeers',
      'managers',
      'revision',
      'since',
      'state',
    ]);
  });

  it('全部在る: entry の 5 欄・指紋 3 つとその probe・resources と probe・pidsSaturation・pushHealth・managers・managerPeers が載る', () => {
    const credentials = [{ name: 'GITHUB_TOKEN', sha256: 'deadbeef0000', updatedAt: 'U' }];
    const profile = { sha256: 'cafef00dbabe', bytes: 3, updatedAt: 'U' };
    const mcpServers = { sha256: 'abc123abc123', names: ['github'], updatedAt: 'U' };
    const resources = { managers: 2, pids: { current: 10, max: 100 } };
    const pushHealth = { agentToken: { status: 'ok' as const, at: 'T' } };
    const pidsSaturation = { basis: [{ kind: 'eagain' as const, count: 1 }], windowMs: 600_000 };
    const overview: RunnerOverview = buildRunnerOverview(
      FULL_ENTRY,
      MANAGERS,
      {
        credentialsProbed: { value: credentials, probe: { status: 'asked' } },
        profileProbed: { value: profile, probe: { status: 'asked' } },
        mcpServersProbed: { value: mcpServers, probe: { status: 'asked' } },
        resourcesProbed: { value: resources, probe: { status: 'asked' } },
        resources,
      },
      pushHealth,
      pidsSaturation,
      { status: 'named', peers: [{ provider: 'codex' }] },
    );
    expect(overview).toEqual({
      label: 'label-a',
      state: 'connected',
      since: '2026-09-30T00:00:00.000Z',
      error: 'boom',
      runnerId: 'runner-a',
      workspacePath: '/work/a',
      instanceId: 'inst-a',
      instanceSince: '2026-09-30T12:00:00.000Z',
      managers: MANAGERS,
      credentials,
      credentialsProbe: { status: 'asked' },
      profile,
      profileProbe: { status: 'asked' },
      mcpServers,
      mcpServersProbe: { status: 'asked' },
      resources,
      resourcesProbe: { status: 'asked' },
      pidsSaturation,
      revision: { status: 'known', commit: 'abcdef0123', short: 'abcdef0', source: 'build' },
      pushHealth,
      managerPeers: { status: 'named', peers: [{ provider: 'codex' }] },
    });
  });

  it('値が無く probe だけ在る（聞けなかった・聞いたが失敗した）: 値の欄は無く probe の欄は載る', () => {
    const overview = buildRunnerOverview(
      FULL_ENTRY,
      [],
      {
        credentialsProbed: { value: undefined, probe: { status: 'unheard' } },
        profileProbed: { value: undefined, probe: { status: 'failed', error: 'profile boom' } },
        mcpServersProbed: { value: undefined, probe: { status: 'asked' } },
        resourcesProbed: { value: undefined, probe: { status: 'failed', error: 'r boom' } },
        resources: undefined,
      },
      undefined,
      undefined,
      { status: 'unknown' },
    );
    expect(overview).toMatchObject({
      credentialsProbe: { status: 'unheard' },
      profileProbe: { status: 'failed', error: 'profile boom' },
      mcpServersProbe: { status: 'asked' },
      resourcesProbe: { status: 'failed', error: 'r boom' },
    });
    for (const key of ['credentials', 'profile', 'mcpServers', 'resources']) {
      expect(key in overview).toBe(false);
    }
  });

  it('resources の欄は引数 resources が決める: probe の value が在っても resources が undefined なら欄は無い（null の正規化は呼び元）', () => {
    const overview = buildRunnerOverview(
      FULL_ENTRY,
      [],
      {
        ...NOTHING,
        resourcesProbed: { value: { managers: 1 }, probe: { status: 'asked' } },
        resources: undefined,
      },
      undefined,
      undefined,
      { status: 'unknown' },
    );
    expect('resources' in overview).toBe(false);
    expect(overview.resourcesProbe).toEqual({ status: 'asked' });
  });

  it('entry の任意欄（error・runnerId・workspacePath・instanceId・instanceSince）は 1 つずつ欠けるとその欄だけ無い', () => {
    for (const key of [
      'error',
      'runnerId',
      'workspacePath',
      'instanceId',
      'instanceSince',
    ] as const) {
      const rest: RunnerEntry = { ...FULL_ENTRY };
      delete rest[key];
      const overview = buildRunnerOverview(rest, [], NOTHING, undefined, undefined, {
        status: 'unknown',
      });
      expect(key in overview).toBe(false);
      for (const other of ['error', 'runnerId', 'workspacePath', 'instanceId', 'instanceSince']) {
        if (other !== key) expect(other in overview).toBe(true);
      }
    }
  });

  it('pushHealth・pidsSaturation は undefined のとき欄ごと無い／managers と managerPeers は渡した値のまま', () => {
    const overview = buildRunnerOverview(FULL_ENTRY, MANAGERS, NOTHING, undefined, undefined, {
      status: 'named',
      peers: [],
      closed: [{ provider: 'codex', reason: '閉じている' }],
    });
    expect('pushHealth' in overview).toBe(false);
    expect('pidsSaturation' in overview).toBe(false);
    expect(overview.managers).toBe(MANAGERS);
    expect(overview.managerPeers).toEqual({
      status: 'named',
      peers: [],
      closed: [{ provider: 'codex', reason: '閉じている' }],
    });
  });
});

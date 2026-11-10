import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AutoFoldOutcome, ManagerSummary, RunnerFleetOverview } from './manager.js';
import { createManagerPool } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_MANAGER_PEERS,
  type PidsSaturation,
  type RunnerClient,
  type RunnerEntry,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerPlacementResources,
} from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import { reportRunnerRevision, resolveBuildRevision } from './revision-resolve.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// `Pool#runners`（`RunnerFleetOverview` を組む段）を、外から見える結果だけで縛る pin。
// 縛るもの: 戻り値の全欄・`runner.credentials/profile/mcpServers/resources` を呼ぶ順と並行・`pidsSaturationOf` へ渡す引数・
// `foldIdleOnRunnerIfUnderPressure` を呼ぶ引数と並行・`runnerBacklog()`（`#runnerBacklog` の読み口）・`runners()` が解けるまでの microtask の周回数。
// 期待の値は、切り出し前の作りの出力から `-u` で生成して目で読んで確かめたもの（仕様を先に書いたものではない）。
// 実時間では待たない: 時計は注入し、待つ箇所はマイクロタスクを回数の上限つきで流すだけ。
// 畳みの本体（`AutoFold` の候補判定・畳み処理）は別の試験が縛るので、ここでは `foldIdleOnRunnerIfUnderPressure` だけを差し替えて、
// 呼び出しの引数と戻り値の取り込み（`autoFolded` の 3 値・`flatMap` の連結の順）だけを見る。

const fold = vi.hoisted(() => ({
  calls: [] as { runnerId: string; pids: { current: number; max: number }; managerIds: string[] }[],
  impl: undefined as
    | undefined
    | ((
        runnerId: string,
        pids: { current: number; max: number },
      ) => Promise<AutoFoldOutcome[] | undefined>),
}));

vi.mock('./auto-fold.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./auto-fold.js')>();
  class AutoFoldStub extends original.AutoFold {
    override async foldIdleOnRunnerIfUnderPressure(
      runnerId: string,
      pids: { current: number; max: number },
      managers: readonly { managerId: string }[],
    ): Promise<AutoFoldOutcome[] | undefined> {
      fold.calls.push({ runnerId, pids, managerIds: managers.map((m) => m.managerId) });
      return fold.impl?.(runnerId, pids);
    }
  }
  return { ...original, AutoFold: AutoFoldStub };
});

const NOW_ISO = '2026-10-01T09:00:00.000Z';
const SINCE = '2026-09-30T00:00:00.000Z';
const REVISION_KNOWN = {
  status: 'known',
  commit: 'abcdef0123456789abcdef0123456789abcdef01',
  short: 'abcdef0',
  source: 'build',
} as const;

const opened: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  fold.calls.length = 0;
  fold.impl = undefined;
  for (const pool of opened.splice(0)) await pool.stop();
});

/** マイクロタスクだけを回数の上限つきで流す（実時間を待たない）。条件が立てば抜ける。 */
async function flush(until: () => boolean = () => false): Promise<number> {
  let turns = 0;
  while (turns < 500 && !until()) {
    await Promise.resolve();
    turns += 1;
  }
  return turns;
}

function job(id: string, runnerId: string | undefined, overrides: Partial<Job> = {}): Job {
  return {
    id,
    managerId: id,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    status: 'done',
    summary: id,
    request: id,
    cwd: '/work/project',
    ...(runnerId === undefined ? {} : { runnerId }),
    ...overrides,
  };
}

function entry(label: string, runnerId: string | undefined, rest: Partial<RunnerEntry> = {}) {
  return {
    label,
    state: 'connected',
    ...(runnerId === undefined ? {} : { runnerId }),
    since: SINCE,
    revision: { status: 'unheard' },
    ...rest,
  } as RunnerEntry;
}

interface Opened {
  pool: ReturnType<typeof createManagerPool>;
  pidsCalls: [string, { current: number; max: number } | undefined][];
  pushed: (results: { runnerId: string; ok: boolean; error?: string }[]) => void;
}

/** 名簿を偽物にして、entry と client を試験が直接握る。 */
async function open(spec: {
  entries: RunnerEntry[];
  clients?: Record<string, Partial<RunnerClient>>;
  jobs?: Job[];
  saturated?: Record<string, PidsSaturation>;
}): Promise<Opened> {
  const stores = createMemoryStores();
  for (const row of spec.jobs ?? []) await stores.jobs.putJob(row);
  const clients = Object.entries(spec.clients ?? {}).map(([runnerId, overrides]) =>
    fakeRunnerClient({ runnerId, ...overrides }),
  );
  const pidsCalls: Opened['pidsCalls'] = [];
  const registry = fakeRunnerRegistry({
    list: () => Promise.resolve(clients),
    get: (runnerId) => Promise.resolve(clients.find((c) => c.runnerId === runnerId) ?? null),
    entries: () => spec.entries.map((e) => ({ ...e })),
    pidsSaturationOf: (runnerId, pids) => {
      pidsCalls.push([runnerId, pids === undefined ? undefined : { ...pids }]);
      return spec.saturated?.[runnerId];
    },
  });
  let listener: ((results: { runnerId: string; ok: boolean; error?: string }[]) => void) | null =
    null;
  const pool = createManagerPool({
    stores,
    now: () => Date.parse(NOW_ISO),
    post: () => {},
    runners: registry,
    agentTokenPushes: {
      onPushed(l) {
        listener = l;
        return () => {};
      },
    },
  });
  opened.push(pool);
  return {
    pool,
    pidsCalls,
    pushed: (results) => listener?.(results),
  };
}

/** `daemonRevision` はビルド由来で試験の環境により変わるので、期待の式と突き合わせてから外す。 */
function withoutDaemonRevision(overview: RunnerFleetOverview) {
  expect(overview.daemonRevision).toEqual(reportRunnerRevision(resolveBuildRevision()));
  return {
    runners: overview.runners,
    unassigned: overview.unassigned,
    ...('autoFolded' in overview ? { autoFolded: overview.autoFolded } : {}),
  };
}

const FULL_RESOURCES: RunnerPlacementResources = {
  managers: 2,
  pids: { current: 10, max: 100 },
  pendingEvents: 3,
  oldestPendingAt: '2026-10-01T08:00:00.000Z',
};

function fleetSpec(): Parameters<typeof open>[0] {
  return {
    entries: [
      // label は runnerId と違う値にする: `managers` を label で引く取り違えを見分けるため。
      entry('label-a', 'runner-a', {
        workspacePath: '/work/a',
        instanceId: 'inst-a',
        instanceSince: '2026-09-30T12:00:00.000Z',
        revision: REVISION_KNOWN,
      }),
      entry('http://later', undefined, { state: 'unreachable', error: 'fetch failed' }),
      entry('runner-min', 'runner-min'),
    ],
    clients: {
      'runner-a': {
        credentials: () =>
          Promise.resolve([
            { name: 'GITHUB_TOKEN', sha256: 'deadbeef0000', updatedAt: '2026-09-01T00:00:00.000Z' },
          ]),
        profile: () =>
          Promise.resolve({
            sha256: 'cafef00dbabe',
            bytes: 3,
            updatedAt: '2026-09-01T00:00:00.000Z',
          }),
        mcpServers: () =>
          Promise.resolve({
            sha256: 'abc123abc123',
            names: ['github'],
            updatedAt: '2026-09-01T00:00:00.000Z',
          }),
        resources: () => Promise.resolve(FULL_RESOURCES),
      },
    },
    jobs: [
      job('mgr-1', 'runner-a'),
      job('mgr-legacy', undefined),
      job('mgr-2', 'runner-a'),
      job('mgr-3', 'runner-min'),
    ],
    saturated: {
      'runner-a': { basis: [{ kind: 'eagain', count: 1 }], windowMs: 600_000 },
    },
  };
}

describe('Pool#runners: 戻り値の全欄（名簿を偽物にして entry を握る）', () => {
  it('何も頼まない: 指紋・資源は聞かず、probe も載らない（欄ごと無い）', async () => {
    const { pool, pidsCalls } = await open(fleetSpec());
    const overview = await pool.runners();
    expect(withoutDaemonRevision(overview)).toMatchInlineSnapshot(`
      {
        "runners": [
          {
            "instanceId": "inst-a",
            "instanceSince": "2026-09-30T12:00:00.000Z",
            "label": "label-a",
            "managerPeers": {
              "status": "unknown",
            },
            "managers": [
              {
                "live": false,
                "managerId": "mgr-1",
                "status": "done",
                "tokenGenerationUnknownReason": "pool-not-wired",
              },
              {
                "live": false,
                "managerId": "mgr-2",
                "status": "done",
                "tokenGenerationUnknownReason": "pool-not-wired",
              },
            ],
            "pidsSaturation": {
              "basis": [
                {
                  "count": 1,
                  "kind": "eagain",
                },
              ],
              "windowMs": 600000,
            },
            "revision": {
              "commit": "abcdef0123456789abcdef0123456789abcdef01",
              "short": "abcdef0",
              "source": "build",
              "status": "known",
            },
            "runnerId": "runner-a",
            "since": "2026-09-30T00:00:00.000Z",
            "state": "connected",
            "workspacePath": "/work/a",
          },
          {
            "error": "fetch failed",
            "label": "http://later",
            "managerPeers": {
              "status": "unknown",
            },
            "managers": [],
            "revision": {
              "status": "unheard",
            },
            "since": "2026-09-30T00:00:00.000Z",
            "state": "unreachable",
          },
          {
            "label": "runner-min",
            "managerPeers": {
              "status": "unknown",
            },
            "managers": [
              {
                "live": false,
                "managerId": "mgr-3",
                "status": "done",
                "tokenGenerationUnknownReason": "pool-not-wired",
              },
            ],
            "revision": {
              "status": "unheard",
            },
            "runnerId": "runner-min",
            "since": "2026-09-30T00:00:00.000Z",
            "state": "connected",
          },
        ],
        "unassigned": [
          {
            "live": false,
            "managerId": "mgr-legacy",
            "status": "done",
            "tokenGenerationUnknownReason": "pool-not-wired",
          },
        ],
      }
    `);
    // 資源を聞いていないので pids は渡さない。runnerId の無い entry では聞かない。
    expect(pidsCalls).toEqual([
      ['runner-a', undefined],
      ['runner-min', undefined],
    ]);
    expect('autoFolded' in overview).toBe(false);
  });

  it('fingerprints:true: 指紋 3 つとその probe が載る。資源は聞かない', async () => {
    const { pool } = await open(fleetSpec());
    expect(withoutDaemonRevision(await pool.runners({ fingerprints: true })))
      .toMatchInlineSnapshot(`
        {
          "runners": [
            {
              "credentials": [
                {
                  "name": "GITHUB_TOKEN",
                  "sha256": "deadbeef0000",
                  "updatedAt": "2026-09-01T00:00:00.000Z",
                },
              ],
              "credentialsProbe": {
                "status": "asked",
              },
              "instanceId": "inst-a",
              "instanceSince": "2026-09-30T12:00:00.000Z",
              "label": "label-a",
              "managerPeers": {
                "status": "unknown",
              },
              "managers": [
                {
                  "live": false,
                  "managerId": "mgr-1",
                  "status": "done",
                  "tokenGenerationUnknownReason": "pool-not-wired",
                },
                {
                  "live": false,
                  "managerId": "mgr-2",
                  "status": "done",
                  "tokenGenerationUnknownReason": "pool-not-wired",
                },
              ],
              "mcpServers": {
                "names": [
                  "github",
                ],
                "sha256": "abc123abc123",
                "updatedAt": "2026-09-01T00:00:00.000Z",
              },
              "mcpServersProbe": {
                "status": "asked",
              },
              "pidsSaturation": {
                "basis": [
                  {
                    "count": 1,
                    "kind": "eagain",
                  },
                ],
                "windowMs": 600000,
              },
              "profile": {
                "bytes": 3,
                "sha256": "cafef00dbabe",
                "updatedAt": "2026-09-01T00:00:00.000Z",
              },
              "profileProbe": {
                "status": "asked",
              },
              "revision": {
                "commit": "abcdef0123456789abcdef0123456789abcdef01",
                "short": "abcdef0",
                "source": "build",
                "status": "known",
              },
              "runnerId": "runner-a",
              "since": "2026-09-30T00:00:00.000Z",
              "state": "connected",
              "workspacePath": "/work/a",
            },
            {
              "credentialsProbe": {
                "status": "unheard",
              },
              "error": "fetch failed",
              "label": "http://later",
              "managerPeers": {
                "status": "unknown",
              },
              "managers": [],
              "mcpServersProbe": {
                "status": "unheard",
              },
              "profileProbe": {
                "status": "unheard",
              },
              "revision": {
                "status": "unheard",
              },
              "since": "2026-09-30T00:00:00.000Z",
              "state": "unreachable",
            },
            {
              "credentialsProbe": {
                "status": "unheard",
              },
              "label": "runner-min",
              "managerPeers": {
                "status": "unknown",
              },
              "managers": [
                {
                  "live": false,
                  "managerId": "mgr-3",
                  "status": "done",
                  "tokenGenerationUnknownReason": "pool-not-wired",
                },
              ],
              "mcpServersProbe": {
                "status": "unheard",
              },
              "profileProbe": {
                "status": "unheard",
              },
              "revision": {
                "status": "unheard",
              },
              "runnerId": "runner-min",
              "since": "2026-09-30T00:00:00.000Z",
              "state": "connected",
            },
          ],
          "unassigned": [
            {
              "live": false,
              "managerId": "mgr-legacy",
              "status": "done",
              "tokenGenerationUnknownReason": "pool-not-wired",
            },
          ],
        }
      `);
  });

  it('resources:true: 資源・resourcesProbe・pidsSaturation（資源の pids を渡して聞く）が載る', async () => {
    const { pool, pidsCalls } = await open(fleetSpec());
    const overview = await pool.runners({ resources: true });
    expect(withoutDaemonRevision(overview)).toMatchInlineSnapshot(`
      {
        "runners": [
          {
            "instanceId": "inst-a",
            "instanceSince": "2026-09-30T12:00:00.000Z",
            "label": "label-a",
            "managerPeers": {
              "status": "unknown",
            },
            "managers": [
              {
                "live": false,
                "managerId": "mgr-1",
                "status": "done",
                "tokenGenerationUnknownReason": "pool-not-wired",
              },
              {
                "live": false,
                "managerId": "mgr-2",
                "status": "done",
                "tokenGenerationUnknownReason": "pool-not-wired",
              },
            ],
            "pidsSaturation": {
              "basis": [
                {
                  "count": 1,
                  "kind": "eagain",
                },
              ],
              "windowMs": 600000,
            },
            "resources": {
              "managers": 2,
              "oldestPendingAt": "2026-10-01T08:00:00.000Z",
              "pendingEvents": 3,
              "pids": {
                "current": 10,
                "max": 100,
              },
            },
            "resourcesProbe": {
              "status": "asked",
            },
            "revision": {
              "commit": "abcdef0123456789abcdef0123456789abcdef01",
              "short": "abcdef0",
              "source": "build",
              "status": "known",
            },
            "runnerId": "runner-a",
            "since": "2026-09-30T00:00:00.000Z",
            "state": "connected",
            "workspacePath": "/work/a",
          },
          {
            "error": "fetch failed",
            "label": "http://later",
            "managerPeers": {
              "status": "unknown",
            },
            "managers": [],
            "resourcesProbe": {
              "status": "unheard",
            },
            "revision": {
              "status": "unheard",
            },
            "since": "2026-09-30T00:00:00.000Z",
            "state": "unreachable",
          },
          {
            "label": "runner-min",
            "managerPeers": {
              "status": "unknown",
            },
            "managers": [
              {
                "live": false,
                "managerId": "mgr-3",
                "status": "done",
                "tokenGenerationUnknownReason": "pool-not-wired",
              },
            ],
            "resourcesProbe": {
              "status": "unheard",
            },
            "revision": {
              "status": "unheard",
            },
            "runnerId": "runner-min",
            "since": "2026-09-30T00:00:00.000Z",
            "state": "connected",
          },
        ],
        "unassigned": [
          {
            "live": false,
            "managerId": "mgr-legacy",
            "status": "done",
            "tokenGenerationUnknownReason": "pool-not-wired",
          },
        ],
      }
    `);
    // 呼ぶ順は「resources の応答が戻った順」: client の無い runner-min は待たずに先に進む（今の作りの出力）。
    expect(pidsCalls).toEqual([
      ['runner-min', undefined],
      ['runner-a', { current: 10, max: 100 }],
    ]);
  });

  it('両方頼む: 全欄が載る。pushHealth は直の配布の結果（帳面）から載り、fingerprints の要否を見ない', async () => {
    const { pool, pushed } = await open(fleetSpec());
    pushed([
      { runnerId: 'runner-a', ok: true },
      { runnerId: 'ghost', ok: false, error: '知らない器' },
    ]);
    const both = await pool.runners({ fingerprints: true, resources: true });
    expect(withoutDaemonRevision(both)).toMatchInlineSnapshot(`
      {
        "runners": [
          {
            "credentials": [
              {
                "name": "GITHUB_TOKEN",
                "sha256": "deadbeef0000",
                "updatedAt": "2026-09-01T00:00:00.000Z",
              },
            ],
            "credentialsProbe": {
              "status": "asked",
            },
            "instanceId": "inst-a",
            "instanceSince": "2026-09-30T12:00:00.000Z",
            "label": "label-a",
            "managerPeers": {
              "status": "unknown",
            },
            "managers": [
              {
                "live": false,
                "managerId": "mgr-1",
                "status": "done",
                "tokenGenerationUnknownReason": "pool-not-wired",
              },
              {
                "live": false,
                "managerId": "mgr-2",
                "status": "done",
                "tokenGenerationUnknownReason": "pool-not-wired",
              },
            ],
            "mcpServers": {
              "names": [
                "github",
              ],
              "sha256": "abc123abc123",
              "updatedAt": "2026-09-01T00:00:00.000Z",
            },
            "mcpServersProbe": {
              "status": "asked",
            },
            "pidsSaturation": {
              "basis": [
                {
                  "count": 1,
                  "kind": "eagain",
                },
              ],
              "windowMs": 600000,
            },
            "profile": {
              "bytes": 3,
              "sha256": "cafef00dbabe",
              "updatedAt": "2026-09-01T00:00:00.000Z",
            },
            "profileProbe": {
              "status": "asked",
            },
            "pushHealth": {
              "agentToken": {
                "at": "2026-10-01T09:00:00.000Z",
                "status": "ok",
              },
            },
            "resources": {
              "managers": 2,
              "oldestPendingAt": "2026-10-01T08:00:00.000Z",
              "pendingEvents": 3,
              "pids": {
                "current": 10,
                "max": 100,
              },
            },
            "resourcesProbe": {
              "status": "asked",
            },
            "revision": {
              "commit": "abcdef0123456789abcdef0123456789abcdef01",
              "short": "abcdef0",
              "source": "build",
              "status": "known",
            },
            "runnerId": "runner-a",
            "since": "2026-09-30T00:00:00.000Z",
            "state": "connected",
            "workspacePath": "/work/a",
          },
          {
            "credentialsProbe": {
              "status": "unheard",
            },
            "error": "fetch failed",
            "label": "http://later",
            "managerPeers": {
              "status": "unknown",
            },
            "managers": [],
            "mcpServersProbe": {
              "status": "unheard",
            },
            "profileProbe": {
              "status": "unheard",
            },
            "resourcesProbe": {
              "status": "unheard",
            },
            "revision": {
              "status": "unheard",
            },
            "since": "2026-09-30T00:00:00.000Z",
            "state": "unreachable",
          },
          {
            "credentialsProbe": {
              "status": "unheard",
            },
            "label": "runner-min",
            "managerPeers": {
              "status": "unknown",
            },
            "managers": [
              {
                "live": false,
                "managerId": "mgr-3",
                "status": "done",
                "tokenGenerationUnknownReason": "pool-not-wired",
              },
            ],
            "mcpServersProbe": {
              "status": "unheard",
            },
            "profileProbe": {
              "status": "unheard",
            },
            "resourcesProbe": {
              "status": "unheard",
            },
            "revision": {
              "status": "unheard",
            },
            "runnerId": "runner-min",
            "since": "2026-09-30T00:00:00.000Z",
            "state": "connected",
          },
        ],
        "unassigned": [
          {
            "live": false,
            "managerId": "mgr-legacy",
            "status": "done",
            "tokenGenerationUnknownReason": "pool-not-wired",
          },
        ],
      }
    `);
    // 何も頼まなくても pushHealth は載る（往復を払わない）。
    const none = await pool.runners();
    expect(none.runners.map((r) => 'pushHealth' in r)).toEqual([true, false, false]);
  });

  it('fingerprints だけ頼んでも resources() は呼ばない／resources だけ頼んでも指紋 3 つは呼ばない', async () => {
    const calls: string[] = [];
    const spec = fleetSpec();
    spec.clients = {
      'runner-a': {
        credentials: () => (calls.push('credentials'), Promise.resolve([])),
        profile: () => (calls.push('profile'), Promise.resolve(undefined)),
        mcpServers: () => (calls.push('mcpServers'), Promise.resolve(undefined)),
        resources: () => (calls.push('resources'), Promise.resolve(undefined)),
      },
    };
    const { pool } = await open(spec);
    await pool.runners();
    expect(calls).toEqual([]);
    await pool.runners({ fingerprints: true });
    expect(calls).toEqual(['credentials', 'profile', 'mcpServers']);
    calls.length = 0;
    await pool.runners({ resources: true });
    expect(calls).toEqual(['resources']);
  });

  it('聞けなかった（client が無い）・聞いたが失敗・応答が null／undefined の 3 通りを probe で区別する', async () => {
    const { pool } = await open({
      entries: [
        entry('runner-a', 'runner-a'),
        entry('runner-bad', 'runner-bad'),
        entry('runner-null', 'runner-null'),
      ],
      clients: {
        'runner-bad': {
          credentials: () => Promise.reject(new Error('credentials boom')),
          profile: () => Promise.reject(new Error('profile boom')),
          mcpServers: () => Promise.reject(new Error('mcp boom')),
          resources: () => Promise.reject(new Error('resources boom')),
        },
        // `null` を返す偽物でも `undefined` にそろう（`resources` の欄は無く、resourcesProbe は asked）。
        'runner-null': {
          resources: () => Promise.resolve(null as unknown as undefined),
        },
      },
    });
    const overview = await pool.runners({ fingerprints: true, resources: true });
    expect(withoutDaemonRevision(overview)).toMatchInlineSnapshot(`
      {
        "runners": [
          {
            "credentialsProbe": {
              "status": "unheard",
            },
            "label": "runner-a",
            "managerPeers": {
              "status": "unknown",
            },
            "managers": [],
            "mcpServersProbe": {
              "status": "unheard",
            },
            "profileProbe": {
              "status": "unheard",
            },
            "resourcesProbe": {
              "status": "unheard",
            },
            "revision": {
              "status": "unheard",
            },
            "runnerId": "runner-a",
            "since": "2026-09-30T00:00:00.000Z",
            "state": "connected",
          },
          {
            "credentialsProbe": {
              "error": "Error: credentials boom",
              "status": "failed",
            },
            "label": "runner-bad",
            "managerPeers": {
              "status": "unknown",
            },
            "managers": [],
            "mcpServersProbe": {
              "error": "Error: mcp boom",
              "status": "failed",
            },
            "profileProbe": {
              "error": "Error: profile boom",
              "status": "failed",
            },
            "resourcesProbe": {
              "error": "Error: resources boom",
              "status": "failed",
            },
            "revision": {
              "status": "unheard",
            },
            "runnerId": "runner-bad",
            "since": "2026-09-30T00:00:00.000Z",
            "state": "connected",
          },
          {
            "credentials": [],
            "credentialsProbe": {
              "status": "asked",
            },
            "label": "runner-null",
            "managerPeers": {
              "status": "unknown",
            },
            "managers": [],
            "mcpServersProbe": {
              "status": "asked",
            },
            "profileProbe": {
              "status": "asked",
            },
            "resourcesProbe": {
              "status": "asked",
            },
            "revision": {
              "status": "unheard",
            },
            "runnerId": "runner-null",
            "since": "2026-09-30T00:00:00.000Z",
            "state": "connected",
          },
        ],
        "unassigned": [],
      }
    `);
    expect('resources' in (overview.runners[2] ?? {})).toBe(false);
  });
});

describe('Pool#runners: managerPeers（名乗りの記憶を runnerId で引く）', () => {
  it('hello で名乗った器は named・名乗っていない器と runnerId の無い entry は unknown', async () => {
    let helloed = false;
    const spec = fleetSpec();
    spec.clients = {
      'runner-a': {
        async connect(onEvent) {
          onEvent({
            type: 'hello',
            runnerId: 'runner-a',
            capabilities: [RUNNER_CAPABILITY_MANAGER_PEERS],
            managerPeers: [{ provider: 'codex', models: ['gpt-5.5'] }],
          });
          helloed = true;
        },
      },
    };
    const { pool } = await open(spec);
    // 名乗りを受けるまで回数の上限つきで回す（`list()` が繋ぐ）。実時間では待たない。
    for (let i = 0; i < 500 && !helloed; i += 1) {
      await pool.runners();
      await Promise.resolve();
    }
    expect(helloed).toBe(true);
    const overview = await pool.runners();
    expect(overview.runners.map((r) => r.managerPeers)).toEqual([
      { status: 'named', peers: [{ provider: 'codex', models: ['gpt-5.5'] }] },
      { status: 'unknown' },
      { status: 'unknown' },
    ]);
  });
});

describe('Pool#runners: managers の振り分け（実の名簿・実の restore を通す）', () => {
  const RUNNER_ID = 'runner-primary';

  function managerRunner() {
    let emit: ((event: RunnerEvent) => void) | null = null;
    const alive: RunnerManagerState[] = [];
    const client = fakeRunnerClient({
      runnerId: RUNNER_ID,
      async connect(onEvent) {
        emit = onEvent;
      },
      async list() {
        return [...alive];
      },
      async resume(command) {
        alive.push({
          liveBackgroundTasks: 0,
          managerId: command.managerId,
          status: 'running',
          cwd: command.cwd,
          request: command.request,
          waiting: [],
          sessionId: command.sessionId,
        });
        return { cwd: command.cwd };
      },
      async setProfile() {
        return { ok: true as const };
      },
    });
    return {
      client,
      report(managerId: string, awaiting: { count: number; breakdown: string }) {
        emit?.({
          type: 'report',
          managerId,
          text: '完了を待つ',
          status: 'done',
          awaitingBackground: awaiting,
        });
      },
    };
  }

  it('runnerId の無い分は unassigned 別枠・同じ runnerId は managers の順を保つ・live を落とさない・世代と背景待ちは在るときだけ載る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      job('mgr-run', RUNNER_ID, { status: 'running', sessionId: 'sess-run' }),
    );
    await stores.jobs.putJob(job('mgr-done', RUNNER_ID));
    await stores.jobs.putJob(job('mgr-legacy', undefined));
    await stores.jobs.putJob(job('mgr-elsewhere', 'runner-gone'));
    await stores.jobs.putJob(
      job('mgr-done-2', RUNNER_ID, { createdAt: '2026-09-30T01:00:00.000Z' }),
    );
    const fake = managerRunner();
    const registry = createRunnerRegistry([fake.client]);
    const pool = createManagerPool({
      stores,
      now: () => Date.parse(NOW_ISO),
      post: () => {},
      runners: registry,
      tokenIdentity: () => ({ tokenId: 'tok-a', generation: 3 }),
    });
    opened.push(pool);
    await pool.restore();
    // 回数の上限つきで回す（実時間を待たない）: `list()` はメモリの台帳を読むだけ。
    const settled = async (isSettled: (s: ManagerSummary | undefined) => boolean) => {
      for (let i = 0; i < 500; i += 1) {
        if (isSettled((await pool.list()).find((m) => m.managerId === 'mgr-run'))) return;
        await Promise.resolve();
      }
      throw new Error('上限の回数を回しても揃わなかった');
    };
    await settled((s) => s?.tokenGeneration === 3);
    fake.report('mgr-run', { count: 2, breakdown: 'local_agent×2' });
    await settled((s) => s?.awaitingBackground !== undefined);

    const overview = await pool.runners();
    // 実の名簿の `since` は実時間（名簿は時計を受けない）なので、形だけ確かめて固定の値に置き換える。
    const normalized = {
      ...withoutDaemonRevision(overview),
      runners: overview.runners.map((r) => {
        expect(Number.isNaN(Date.parse(r.since))).toBe(false);
        return { ...r, since: '<registry-real-clock>' };
      }),
    };
    expect(normalized).toMatchInlineSnapshot(`
      {
        "runners": [
          {
            "label": "runner-primary",
            "managerPeers": {
              "status": "unknown",
            },
            "managers": [
              {
                "live": false,
                "managerId": "mgr-done-2",
                "status": "done",
                "tokenGenerationUnknownReason": "not-yet-observed",
              },
              {
                "activeTokenGeneration": 3,
                "awaitingBackground": {
                  "breakdown": "local_agent×2",
                  "since": "2026-10-01T09:00:00.000Z",
                  "tasks": 2,
                  "withheldReports": 1,
                },
                "live": true,
                "managerId": "mgr-run",
                "status": "done",
                "tokenGeneration": 3,
              },
              {
                "live": false,
                "managerId": "mgr-done",
                "status": "done",
                "tokenGenerationUnknownReason": "not-yet-observed",
              },
            ],
            "revision": {
              "status": "unheard",
            },
            "runnerId": "runner-primary",
            "since": "<registry-real-clock>",
            "state": "connected",
            "workspacePath": "/work/project",
          },
        ],
        "unassigned": [
          {
            "live": false,
            "managerId": "mgr-legacy",
            "status": "done",
            "tokenGenerationUnknownReason": "not-yet-observed",
          },
        ],
      }
    `);
    await registry.stop();
  });
});

describe('Pool#runners: backlog の記録（runnerBacklog() の読み口）', () => {
  function backlogSpec(): Parameters<typeof open>[0] {
    const resourcesOf = (r: RunnerPlacementResources | undefined) => ({
      resources: () => Promise.resolve(r),
    });
    return {
      entries: [
        entry('runner-a', 'runner-a', { instanceId: 'inst-a' }),
        entry('runner-zero', 'runner-zero'),
        entry('runner-old', 'runner-old', { instanceId: 'inst-old' }),
        entry('http://later', undefined),
      ],
      clients: {
        'runner-a': resourcesOf({ pendingEvents: 3, oldestPendingAt: '2026-10-01T08:00:00.000Z' }),
        // 0 件でも数値なので記録する（0 を捏造しているのではなく測れている）。`oldestPendingAt` が無ければ欄ごと無い。
        'runner-zero': resourcesOf({ pendingEvents: 0 }),
        // `pendingEvents` が無い（古い runner・形が壊れていた）ものは書かない。
        'runner-old': resourcesOf({ managers: 1 }),
      },
    };
  }

  it('数値のときだけ載る（oldestPendingAt は在れば・instanceIdAtObservation は entry.instanceId が在れば）。観測時刻は注入した時計', async () => {
    const { pool } = await open(backlogSpec());
    await pool.runners({ resources: true });
    expect(pool.runnerBacklog()).toMatchInlineSnapshot(`
      [
        {
          "instanceIdAtObservation": "inst-a",
          "instanceSwapped": false,
          "observedAt": "2026-10-01T09:00:00.000Z",
          "oldestPendingAt": "2026-10-01T08:00:00.000Z",
          "pendingEvents": 3,
          "runnerId": "runner-a",
        },
        {
          "observedAt": "2026-10-01T09:00:00.000Z",
          "pendingEvents": 0,
          "runnerId": "runner-zero",
        },
      ]
    `);
  });

  it('resources を頼まなければ記録しない', async () => {
    const { pool } = await open(backlogSpec());
    await pool.runners();
    await pool.runners({ fingerprints: true });
    expect(pool.runnerBacklog()).toEqual([]);
  });

  it('pendingEvents が undefined の回は前の記録を消さず、0 でも埋めない', async () => {
    const spec = backlogSpec();
    let report: RunnerPlacementResources | undefined = {
      pendingEvents: 5,
      oldestPendingAt: '2026-10-01T07:00:00.000Z',
    };
    spec.clients = { 'runner-a': { resources: () => Promise.resolve(report) } };
    const { pool } = await open(spec);
    await pool.runners({ resources: true });
    expect(pool.runnerBacklog().map((s) => [s.runnerId, s.pendingEvents])).toEqual([
      ['runner-a', 5],
    ]);
    report = undefined;
    await pool.runners({ resources: true });
    expect(pool.runnerBacklog().map((s) => [s.runnerId, s.pendingEvents])).toEqual([
      ['runner-a', 5],
    ]);
    report = { pendingEvents: 1 };
    await pool.runners({ resources: true });
    // 新しい観測は oldestPendingAt の欄ごと置き換わる（前の値を持ち越さない）。
    expect(pool.runnerBacklog()).toMatchInlineSnapshot(`
      [
        {
          "instanceIdAtObservation": "inst-a",
          "instanceSwapped": false,
          "observedAt": "2026-10-01T09:00:00.000Z",
          "pendingEvents": 1,
          "runnerId": "runner-a",
        },
      ]
    `);
  });
});

describe('Pool#runners: autoFolded の 3 値（見ていない・見たが 0 件・配列）', () => {
  const OUTCOME_A: AutoFoldOutcome = {
    managerId: 'mgr-a',
    runnerId: 'runner-a',
    outcome: 'folded',
    detail: 'a を畳んだ',
  };
  const OUTCOME_C1: AutoFoldOutcome = {
    managerId: 'mgr-c1',
    runnerId: 'runner-c',
    outcome: 'raced',
    detail: 'c1',
  };
  const OUTCOME_C2: AutoFoldOutcome = {
    managerId: 'mgr-c2',
    runnerId: 'runner-c',
    outcome: 'not-stopped',
    detail: 'c2',
  };

  function foldSpec(withPids: Record<string, { current: number; max: number } | undefined>) {
    const clients: Record<string, Partial<RunnerClient>> = {};
    for (const [runnerId, pids] of Object.entries(withPids)) {
      clients[runnerId] = {
        resources: () =>
          Promise.resolve(pids === undefined ? { managers: 0 } : { managers: 0, pids }),
      };
    }
    return {
      entries: [
        entry('runner-a', 'runner-a'),
        entry('http://later', undefined),
        entry('runner-b', 'runner-b'),
        entry('runner-c', 'runner-c'),
      ],
      clients,
      jobs: [job('mgr-a', 'runner-a'), job('mgr-legacy', undefined)],
    };
  }

  it('配列・[]・undefined が混ざる: 1 台でも見たら欄が在り、entries の順に連結する。引数は resources の pids と全 managers', async () => {
    fold.impl = async (runnerId) =>
      runnerId === 'runner-a'
        ? [OUTCOME_A]
        : runnerId === 'runner-b'
          ? []
          : [OUTCOME_C1, OUTCOME_C2];
    const { pool } = await open(
      foldSpec({
        'runner-a': { current: 1, max: 10 },
        'runner-b': { current: 2, max: 10 },
        'runner-c': { current: 3, max: 10 },
      }),
    );
    const overview = await pool.runners({ resources: true });
    expect(overview.autoFolded).toEqual([OUTCOME_A, OUTCOME_C1, OUTCOME_C2]);
    expect(fold.calls).toEqual([
      { runnerId: 'runner-a', pids: { current: 1, max: 10 }, managerIds: ['mgr-a', 'mgr-legacy'] },
      { runnerId: 'runner-b', pids: { current: 2, max: 10 }, managerIds: ['mgr-a', 'mgr-legacy'] },
      { runnerId: 'runner-c', pids: { current: 3, max: 10 }, managerIds: ['mgr-a', 'mgr-legacy'] },
    ]);
    // 欄ごとの値は entry ごとに混ざらない（overview 側には autoFolded を載せない）。
    expect(overview.runners.map((r) => 'autoFolded' in r)).toEqual([false, false, false, false]);
  });

  it('全台が undefined のときだけ欄そのものを省く（pids を聞けなかった・runnerId が無い・畳みが undefined）', async () => {
    fold.impl = async () => undefined;
    const { pool } = await open(
      foldSpec({
        'runner-a': { current: 1, max: 10 },
        'runner-b': undefined,
        'runner-c': { current: 3, max: 10 },
      }),
    );
    const overview = await pool.runners({ resources: true });
    expect('autoFolded' in overview).toBe(false);
    // pids の無い runner-b・runnerId の無い entry では畳みを呼ばない。
    expect(fold.calls.map((c) => c.runnerId)).toEqual(['runner-a', 'runner-c']);
  });

  it('全台が [] なら欄は在って空配列（見たが 0 件を、見ていないに潰さない）', async () => {
    fold.impl = async () => [];
    const { pool } = await open(foldSpec({ 'runner-a': { current: 1, max: 10 } }));
    const overview = await pool.runners({ resources: true });
    expect('autoFolded' in overview).toBe(true);
    expect(overview.autoFolded).toEqual([]);
  });

  it('resources を頼まなければ畳みは呼ばず欄も無い', async () => {
    fold.impl = async () => [OUTCOME_A];
    const { pool } = await open(foldSpec({ 'runner-a': { current: 1, max: 10 } }));
    const overview = await pool.runners();
    expect(fold.calls).toEqual([]);
    expect('autoFolded' in overview).toBe(false);
  });
});

describe('Pool#runners: 呼び出しの順・並行・await の周回', () => {
  it('entry ごとに指紋 3 つを同時に呼び、全 entry が並行に進み、resources は 3 つが解けてから呼ぶ。畳みも並行', async () => {
    const log: string[] = [];
    const gates = new Map<string, () => void>();
    const hold = <T>(name: string, value: T): Promise<T> => {
      log.push(name);
      return new Promise<T>((resolve) => {
        gates.set(name, () => resolve(value));
      });
    };
    const clientFor = (id: string): Partial<RunnerClient> => ({
      credentials: () => hold(`${id}:credentials`, []),
      profile: () => hold(`${id}:profile`, undefined),
      mcpServers: () => hold(`${id}:mcpServers`, undefined),
      resources: () => hold(`${id}:resources`, { managers: 0, pids: { current: 1, max: 10 } }),
    });
    fold.impl = (runnerId) => {
      log.push(`${runnerId}:fold`);
      return new Promise((resolve) => {
        gates.set(`${runnerId}:fold`, () => resolve([]));
      });
    };
    const { pool } = await open({
      entries: [entry('runner-a', 'runner-a'), entry('runner-b', 'runner-b')],
      clients: { 'runner-a': clientFor('a'), 'runner-b': clientFor('b') },
    });
    let done = false;
    const running = pool.runners({ fingerprints: true, resources: true }).then((r) => {
      done = true;
      return r;
    });

    await flush(() => log.length >= 6);
    expect(log).toEqual([
      'a:credentials',
      'a:profile',
      'a:mcpServers',
      'b:credentials',
      'b:profile',
      'b:mcpServers',
    ]);

    // a の指紋だけ解く: a の resources は呼ばれ、b はまだ。
    for (const key of ['credentials', 'profile', 'mcpServers']) gates.get(`a:${key}`)?.();
    await flush(() => log.includes('a:resources'));
    expect(log.slice(6)).toEqual(['a:resources']);

    for (const key of ['credentials', 'profile', 'mcpServers']) gates.get(`b:${key}`)?.();
    await flush(() => log.includes('b:resources'));
    expect(log.slice(6)).toEqual(['a:resources', 'b:resources']);

    // 資源を b から先に解く: 畳みは a を待たずに b から呼ばれる（並行）。
    gates.get('b:resources')?.();
    await flush(() => log.includes('runner-b:fold'));
    expect(log.slice(8)).toEqual(['runner-b:fold']);
    gates.get('a:resources')?.();
    await flush(() => log.includes('runner-a:fold'));
    expect(log.slice(8)).toEqual(['runner-b:fold', 'runner-a:fold']);
    expect(done).toBe(false);

    gates.get('runner-a:fold')?.();
    gates.get('runner-b:fold')?.();
    const overview = await running;
    expect(overview.autoFolded).toEqual([]);
  });

  it('runners() が解けるまでの microtask の周回数（await の追加・削除を検出する）', async () => {
    const spec = fleetSpec();
    const turnsOf = async (options: Parameters<Opened['pool']['runners']>[0]) => {
      const { pool } = await open(spec);
      let done = false;
      const running = pool.runners(options).then(() => {
        done = true;
      });
      const turns = await flush(() => done);
      await running;
      return turns;
    };
    expect({
      none: await turnsOf({}),
      fingerprints: await turnsOf({ fingerprints: true }),
      resources: await turnsOf({ resources: true }),
      both: await turnsOf({ fingerprints: true, resources: true }),
    }).toMatchInlineSnapshot(`
      {
        "both": 30,
        "fingerprints": 28,
        "none": 25,
        "resources": 29,
      }
    `);
  });
});

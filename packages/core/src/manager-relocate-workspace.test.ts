import { describe, expect, it } from 'vitest';

import { createManagerPool, type WorkspacePolicy } from './manager.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEntry,
  RunnerLiveness,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRegistry,
  RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job, WorkspaceLocator } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * 別の runner へ移送したあとの `job.workspace`（locator）の扱い（Issue #3099）。
 *
 * `RunnerRegistry` は偽物（`entries()` の行を試験ごとに差し替える）。
 */

/** 名簿の1行を組み立てる（`RunnerEntry` の必須欄はここで埋める）。 */
function entryOf(label: string, state: RunnerLiveness, runnerId?: string): RunnerEntry {
  return {
    label,
    state,
    ...(runnerId === undefined ? {} : { runnerId }),
    since: '2026-08-01T00:00:00.000Z',
    revision: { status: 'unheard' },
  };
}

/**
 * `RunnerRegistry` の9メンバを満たす偽物。**この試験群で使うのは `get` /
 * `entries` の2つだけ**（`#reattach` が実際に読むのはこの2つである）。残りは
 * 型を満たすだけで、呼ばれたら「使わない」と分かる形にしてある。
 *
 * **`vacate` だけは「使わない」にしていない。** 本物（`Registry#vacate`）と
 * 同じ効果（`entries` の該当行を `'vacating'` へ倒す）を持たせてある——
 * `ManagerPool.vacate()`（#485 PR-2）を試験するとき、`fake.entries.push` で
 * 手で先に `'vacating'` を置く形と、`pool.vacate()` を呼んで名簿側から
 * 倒させる形の両方を、同じ偽物で試せるようにするためである。
 */
function createFakeRegistry(): {
  registry: RunnerRegistry;
  /** 試験ごとに push / state 書き換えで差し替える。 */
  entries: RunnerEntry[];
  /** `get(runnerId)` が返す `RunnerClient` を登録する。 */
  addClient: (client: RunnerClient) => void;
  /** `get()` に渡された runnerId を呼ばれた順に記録する（#8 の検証用）。 */
  gotten: string[];
} {
  const clients = new Map<string, RunnerClient>();
  const entries: RunnerEntry[] = [];
  const gotten: string[] = [];
  const registry: RunnerRegistry = {
    async list() {
      return [...clients.values()];
    },
    async get(runnerId) {
      gotten.push(runnerId);
      return clients.get(runnerId) ?? null;
    },
    async select() {
      throw new Error('この試験群では使わない（配置は検証対象ではない）');
    },
    async register() {
      /* この試験群では使わない（`addClient` で直接足す）。 */
    },
    async unregister() {
      /* この試験群では使わない。 */
    },
    vacate(runnerId) {
      for (const entry of entries) {
        if (entry.runnerId === runnerId) entry.state = 'vacating';
      }
    },
    entries() {
      // **試験が直接 push / 変異させた行を、呼ばれるたびに読み直す。** コピーを
      // 返すのは、呼び出し側（`manager.ts`）が返り値を書き換えないことを
      // 前提にしないためである。
      return entries.map((entry) => ({ ...entry }));
    },
    noteManagerFailed() {
      /* この試験群では使わない（配置は検証対象ではない）。 */
    },
    subscribe() {
      return () => {};
    },
    async stop() {},
  };
  return {
    registry,
    entries,
    addClient: (client) => clients.set(client.runnerId, client),
    gotten,
  };
}

/**
 * 偽の `RunnerClient`。`swappableRunner`（`manager-workspace-nudge.test.ts`）・
 * `LeasedRunner`（`manager-lease.test.ts`）と同じ形。
 */
function fakeRunner(
  runnerId: string,
  workspacePath = '/work/project',
): { client: RunnerClient; resumes: RunnerResumeCommand[] } {
  const resumes: RunnerResumeCommand[] = [];
  const sessions = new Map<string, RunnerManagerState>();
  const client: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath,
    async connect() {
      /* この試験群は hello イベントの配送経路を使わない（`reattachRunner` /
       * `relocateFrom` が直に `#reattach` を起こす）。 */
    },
    async start(): Promise<{ cwd?: string }> {
      /* この試験群では使わない。 */
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      resumes.push(command);
      sessions.set(command.managerId, {
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
      return {};
    },
    async send() {
      /* この試験群では使わない。 */
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      sessions.delete(managerId);
    },
    async list() {
      return [...sessions.values()];
    },
    async transcript() {
      return null;
    },
    async credentials(): Promise<RunnerCredentialFingerprint[]> {
      return [];
    },
    async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
      return [];
    },
    async profile(): Promise<RunnerProfileFingerprint | undefined> {
      return undefined;
    },
    async setProfile(): Promise<RunnerProfileResult> {
      return { ok: true };
    },
    async close() {
      /* この試験群では使わない。 */
    },
  };
  return { client, resumes };
}

/** 走行中の委譲を組み立てる。`runnerId` は台帳の記録した宛先。 */
function jobWith(id: string, runnerId: string | undefined, overrides: Partial<Job> = {}): Job {
  return {
    id,
    managerId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running',
    summary: '走行中の委譲',
    request: '続きをやって',
    cwd: '/work/project',
    sessionId: 'sess-before-relocate',
    lastReport: '途中まで進めた',
    ...(runnerId === undefined ? {} : { runnerId }),
    ...overrides,
  };
}

function setup(stores: ReturnType<typeof createMemoryStores>, registry: RunnerRegistry) {
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({ stores, post: (event) => inbox.push(event), runners: registry });
  return { pool, inbox };
}

describe('移送後の台帳の workspace locator', () => {
  it('別の runner へ移送して cwd が変わらなかったとき、workspace locator の runnerId も新しい宛先へ付け替わる', async () => {
    const stores = createMemoryStores();
    const workspace: WorkspaceLocator = {
      kind: 'unknown',
      runnerId: 'runner-a',
      path: '/work/project',
      reason: 'x',
    };
    await stores.jobs.putJob(jobWith('mgr-ws', 'runner-a', { workspace }));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');
    expect(runnerB.resumes).toHaveLength(1);

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-ws');
    expect(job?.runnerId).toBe('runner-b');
    expect(job?.workspace).toMatchObject({ runnerId: 'runner-b' });
    await pool.stop();
  });

  /** a → b へ移送し、台帳の workspace を返す。`swapCwdTo` を渡すと b が cwd を差し替えて開く。 */
  async function relocate(
    workspace: WorkspaceLocator,
    options: { policy?: WorkspacePolicy; swapCwdTo?: string } = {},
  ): Promise<WorkspaceLocator | undefined> {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-ws', 'runner-a', { workspace }));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    const { swapCwdTo } = options;
    if (swapCwdTo !== undefined) {
      const original = runnerB.client.resume.bind(runnerB.client);
      runnerB.client.resume = async (command) => {
        await original(command);
        return { cwd: swapCwdTo };
      };
    }
    fake.addClient(runnerB.client);
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: fake.registry,
      ...(options.policy === undefined ? {} : { workspace: options.policy }),
    });
    await pool.reattachRunner('runner-b');
    expect(runnerB.resumes).toHaveLength(1);
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-ws');
    expect(job?.runnerId).toBe('runner-b');
    await pool.stop();
    return job?.workspace;
  }

  const unknownA: WorkspaceLocator = {
    kind: 'unknown',
    runnerId: 'runner-a',
    path: '/work/project',
    reason: 'x',
  };
  const volumeA: WorkspaceLocator = {
    kind: 'runner-volume',
    runnerId: 'runner-a',
    path: '/work/project',
  };

  it('unknown は cwd が倒れても、移送先へ付け替わる（reason と path は保つ）', async () => {
    expect(
      await relocate(unknownA, {
        swapCwdTo: '/work/other',
        policy: { kind: 'unknown', reason: 'policy' },
      }),
    ).toEqual({ kind: 'unknown', runnerId: 'runner-b', path: '/work/other', reason: 'policy' });
  });

  it('runner-volume は移送後 unknown になり、移送で中身は運ばれていないことを reason に書く（cwd が同じとき）', async () => {
    const after = await relocate(volumeA);
    expect(after).toMatchObject({ kind: 'unknown', runnerId: 'runner-b', path: '/work/project' });
    expect(after?.kind === 'unknown' && after.reason).toContain('運ばれていない');
  });

  it('runner-volume は cwd が倒れた移送でも unknown になる（方針が runner-volume でも）', async () => {
    const after = await relocate(volumeA, {
      swapCwdTo: '/work/other',
      policy: { kind: 'runner-volume' },
    });
    expect(after).toMatchObject({ kind: 'unknown', runnerId: 'runner-b', path: '/work/other' });
    expect(after?.kind === 'unknown' && after.reason).toContain('運ばれていない');
  });

  it('shared-volume と git は移送で1文字も変わらない', async () => {
    const shared: WorkspaceLocator = { kind: 'shared-volume', path: '/shared/project' };
    const git: WorkspaceLocator = {
      kind: 'git',
      repository: 'https://example.com/r.git',
      ref: 'main',
    };
    expect(await relocate(shared)).toEqual(shared);
    expect(await relocate(git)).toEqual(git);
  });
});

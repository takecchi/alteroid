import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { RunnerHttpError } from './runner-protocol.js';
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
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * 移送先の runner が resume を 4xx で断ったときの扱い（Issue #3098）。
 *
 * 1台の断りは「その runner の都合」であって委譲の運命ではない。ほかに候補が居れば移すのを試し、
 * 全員に断られたら lost に確定する。委譲そのものが不正だと分かる断り（400 / 415 / 422）は、
 * ほかへ回さず従来どおり止める。移送ではない元の runner への復帰は変えない。
 *
 * `RunnerRegistry` は偽物（`entries()` の行を試験ごとに差し替える）。本物は `state` を
 * 接続・heartbeat から計算するので、`lost` を挟むには時間経過を模す必要がある。
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

describe('移送先 1 台の 4xx は、その runner の都合として扱い、ほかの候補へ移すのを試す', () => {
  async function jobOf(stores: ReturnType<typeof createMemoryStores>, id: string) {
    return (await stores.jobs.listJobs()).find((j) => j.id === id);
  }

  it('runner-b が resume を 4xx で断っても、runner-c が受けられるなら、runner-a の委譲は runner-c へ移る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-4xx', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
    const runnerB = fakeRunner('runner-b');
    runnerB.client.resume = async () => {
      throw new RunnerHttpError('forbidden (runner-b 固有の設定)', 403);
    };
    const runnerC = fakeRunner('runner-c');
    fake.addClient(runnerB.client);
    fake.addClient(runnerC.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');
    await pool.reattachRunner('runner-c');

    const job = await jobOf(stores, 'mgr-4xx');
    expect({
      resumesOnC: runnerC.resumes.length,
      status: job?.status,
      runnerId: job?.runnerId,
    }).toEqual({ resumesOnC: 1, status: 'running', runnerId: 'runner-c' });
    // b に貸した貸し出しを返したことが日誌に残る（`releaseLease` の doc。黙って返さない）
    const decisions = (await stores.journal.list({ limit: 200 })).flatMap((entry) =>
      entry.type === 'decision' ? [entry.decision] : [],
    );
    expect(
      decisions.some((text) => text.includes('移送先 runner-b に貸した貸し出しを返した')),
    ).toBe(true);
    await pool.stop();
  });

  it('b が先に断り、c が後で受ける（relocateFrom が並行に起こす）順でも c へ移る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-4xx-par', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
    const runnerB = fakeRunner('runner-b');
    runnerB.client.resume = async () => {
      throw new RunnerHttpError('not found (古い版の runner)', 404);
    };
    const runnerC = fakeRunner('runner-c');
    fake.addClient(runnerB.client);
    fake.addClient(runnerC.client);
    const { pool } = setup(stores, fake.registry);

    await Promise.all([pool.reattachRunner('runner-b'), pool.reattachRunner('runner-c')]);
    // c の関門が b の貸し出しに当たって断られた回は、挑み直しの梯子（1秒）で拾われる。
    await vi.waitFor(
      async () => expect((await jobOf(stores, 'mgr-4xx-par'))?.runnerId).toBe('runner-c'),
      {
        timeout: 5_000,
        interval: 50,
      },
    );

    const job = await jobOf(stores, 'mgr-4xx-par');
    expect({ status: job?.status, runnerId: job?.runnerId }).toEqual({
      status: 'running',
      runnerId: 'runner-c',
    });
    await pool.stop();
  });

  it('候補を全部断られたら lost に確定する（それ以上は試さない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-all-refused', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
    let attemptsB = 0;
    let attemptsC = 0;
    const runnerB = fakeRunner('runner-b');
    runnerB.client.resume = async () => {
      attemptsB += 1;
      throw new RunnerHttpError('forbidden', 403);
    };
    const runnerC = fakeRunner('runner-c');
    runnerC.client.resume = async () => {
      attemptsC += 1;
      throw new RunnerHttpError('forbidden', 401);
    };
    fake.addClient(runnerB.client);
    fake.addClient(runnerC.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');
    // b だけが断った時点では確定しない（c が残っている）。
    expect((await jobOf(stores, 'mgr-all-refused'))?.status).toBe('running');
    await pool.reattachRunner('runner-c');
    await pool.reattachRunner('runner-b');
    await pool.reattachRunner('runner-c');

    const job = await jobOf(stores, 'mgr-all-refused');
    expect({ status: job?.status, attemptsB, attemptsC }).toEqual({
      status: 'lost',
      attemptsB: 1,
      attemptsC: 1,
    });
    await pool.stop();
  });

  it('候補が断った 1 台しか居なければ、従来どおりその場で lost に確定する', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-only-b', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerB = fakeRunner('runner-b');
    runnerB.client.resume = async () => {
      throw new RunnerHttpError('forbidden', 403);
    };
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');

    expect((await jobOf(stores, 'mgr-only-b'))?.status).toBe('lost');
    await pool.stop();
  });

  for (const status of [400, 415, 422]) {
    it(`委譲そのものが不正だと分かる断り（${String(status)}）は、c があってもほかへ回さず従来どおり止める`, async () => {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-invalid', 'runner-a'));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
      fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
      const runnerB = fakeRunner('runner-b');
      runnerB.client.resume = async () => {
        throw new RunnerHttpError('再開命令の入力の形が不正', status);
      };
      const runnerC = fakeRunner('runner-c');
      fake.addClient(runnerB.client);
      fake.addClient(runnerC.client);
      const { pool } = setup(stores, fake.registry);

      await pool.reattachRunner('runner-b');
      await pool.reattachRunner('runner-c');

      const job = await jobOf(stores, 'mgr-invalid');
      expect({ status: job?.status, resumesOnC: runnerC.resumes.length }).toEqual({
        status: 'lost',
        resumesOnC: 0,
      });
      await pool.stop();
    });
  }

  it('移送ではない元の runner への復帰は変えない（4xx で断られたら、ほかの候補が居ても従来どおり lost）', async () => {
    const stores = createMemoryStores();
    // 台帳の宛先は runner-b 自身（移送ではない）。runner-c は connected で居る。
    await stores.jobs.putJob(jobWith('mgr-same-runner', 'runner-b'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
    const runnerB = fakeRunner('runner-b');
    runnerB.client.resume = async () => {
      throw new RunnerHttpError('forbidden', 403);
    };
    const runnerC = fakeRunner('runner-c');
    fake.addClient(runnerB.client);
    fake.addClient(runnerC.client);
    const { pool } = setup(stores, fake.registry);

    await pool.reattachRunner('runner-b');
    await pool.reattachRunner('runner-c');

    const job = await jobOf(stores, 'mgr-same-runner');
    expect({ status: job?.status, resumesOnC: runnerC.resumes.length }).toEqual({
      status: 'lost',
      resumesOnC: 0,
    });
    await pool.stop();
  });
});

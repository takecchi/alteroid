import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
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
 * 本物の `createRunnerRegistry()` は `entries()` の `state` を実際の接続・heartbeat から計算し、
 * `lost` を作るのに時間経過を模す必要があるので使わない。`vacate` だけは本物と同じく該当行を
 * `'vacating'` へ倒す（`pool.vacate()` から名簿側を倒させる形を試すため）。
 */
function createFakeRegistry(): {
  registry: RunnerRegistry;
  entries: RunnerEntry[];
  addClient: (client: RunnerClient) => void;
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
      // コピーを返す: 呼び出し側が返り値を書き換えないことを前提にしない。
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

describe('vacate の await の間に、同じ委譲が別の runner へ引き取られたら', () => {
  async function race() {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-race', 'runner-a', {
        lease: {
          runnerId: 'runner-a',
          fence: 4,
          grantedAt: '2026-01-01T00:00:00.000Z',
          seenAt: '2026-01-01T00:00:00.000Z',
          ttlMs: 60_000,
        },
      }),
    );
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerA = fakeRunner('runner-a');
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerA.client);
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let stopEntered: () => void = () => {};
    const stopReached = new Promise<void>((resolve) => {
      stopEntered = resolve;
    });
    const originalStop = runnerA.client.stop;
    runnerA.client.stop = async (managerId: string) => {
      stopEntered();
      await stopGate;
      return originalStop(managerId);
    };

    const vacating = pool.vacate('runner-a');
    await stopReached;
    await pool.reattachRunner('runner-b');
    expect(runnerB.resumes.map((c) => c.managerId)).toEqual(['mgr-race']);

    releaseStop();
    await vacating;
    return { pool, stores, runnerB };
  }

  it('新しい runner が握っている貸し出しを返さない', async () => {
    const { pool, stores } = await race();
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    expect(job?.runnerId).toBe('runner-b');
    expect(job?.lease?.runnerId).toBe('runner-b');
    expect(job?.lease?.releasedAt).toBeUndefined();
    await pool.stop();
  });

  it('その後に像が永続化されても、新しい runner の貸し出しは解放済みにならない', async () => {
    const { pool, stores, runnerB } = await race();
    await pool.send('mgr-race', '続きを');
    expect(runnerB.resumes).toHaveLength(1);
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    expect(job?.lease?.runnerId).toBe('runner-b');
    expect(job?.lease?.releasedAt).toBeUndefined();
    await pool.stop();
  });
});

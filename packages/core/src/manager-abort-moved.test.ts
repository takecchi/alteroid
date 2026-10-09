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

describe('abort の await の間に、同じ委譲が別の runner へ引き取られたら', () => {
  function entryOf(label: string, state: RunnerLiveness, runnerId?: string): RunnerEntry {
    return {
      label,
      state,
      ...(runnerId === undefined ? {} : { runnerId }),
      since: '2026-08-01T00:00:00.000Z',
      revision: { status: 'unheard' },
    };
  }

  function createFakeRegistry(): {
    registry: RunnerRegistry;
    entries: RunnerEntry[];
    addClient: (client: RunnerClient) => void;
  } {
    const clients = new Map<string, RunnerClient>();
    const entries: RunnerEntry[] = [];
    const registry: RunnerRegistry = {
      async list() {
        return [...clients.values()];
      },
      async get(runnerId) {
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
      vacate() {
        /* この試験群では使わない（`abort()` を試すのであって `vacate()` ではない）。 */
      },
      entries() {
        return entries.map((entry) => ({ ...entry }));
      },
      noteManagerFailed() {
        /* この試験群では使わない。 */
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
        /* この試験群は hello イベントの配送経路を使わない。 */
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
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: registry,
    });
    return { pool, inbox };
  }

  it('runner-b へ移って走り続けている委譲を「止まった」ことにしない', async () => {
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
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
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

    const aborting = pool.abort('mgr-race', undefined, 'human');
    await stopReached;
    // resume が出るかは止めた意思の印（`stopConfirmedAt`）の効き方で変わる。どちらの結果でも不変条件を測れるよう、`resumes` が0件でも1件でも保証を弱めずに確かめる。
    await pool.reattachRunner('runner-b');
    const resumedOnB = runnerB.resumes.length > 0;
    if (resumedOnB) {
      expect(runnerB.resumes.map((c) => c.managerId)).toEqual(['mgr-race']);
      const relocated = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
      expect(relocated?.runnerId).toBe('runner-b');
      expect(relocated?.status).toBe('running');
    }

    releaseStop();
    const result = await aborting;

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    // 直し方が2通りありうる（abort を降りて runner-b に任せる／runner-b でも止める）ので、どちらかを決め打ちせず不変条件だけを測る。
    const aliveOnB = (await runnerB.client.list()).some((s) => s.managerId === 'mgr-race');
    expect({ ledger: job?.status, answered: result.outcome, aliveOnB }).not.toMatchObject({
      aliveOnB: true,
      ledger: 'stopped',
    });
    if (result.outcome === 'stopped') expect(aliveOnB).toBe(false);

    // 「何もしなかった」逃げ道（`unknown` に倒れて何も確定させない）で不変条件を満たしていないことを区別する。
    if (!resumedOnB) {
      expect(result.outcome).toBe('stopped');
      expect(job?.status).toBe('stopped');
    }

    await pool.stop();
  });
});

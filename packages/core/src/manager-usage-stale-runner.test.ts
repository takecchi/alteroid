import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEntry,
  RunnerEvent,
  RunnerLiveness,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRegistry,
  RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { UsageTotals } from './usage.js';

const FIXED_NOW = Date.parse('2026-08-01T12:00:00.000Z');

function totals(costUsd: number): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd,
  };
}

async function costOf(stores: ReturnType<typeof createMemoryStores>): Promise<number> {
  const { rows } = await stores.usage.aggregate({});
  return rows.reduce((sum, row) => sum + row.totals.costUsd, 0);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function usageEvent(costUsd: number): RunnerEvent {
  return {
    type: 'usage',
    managerId: 'mgr-race',
    sessionId: 'sess-before-relocate',
    models: { opus: totals(costUsd) },
  } as unknown as RunnerEvent;
}

describe('引き取り後に届く古い runner の usage は、過大に数えない（#3022 仮説1）', () => {
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
        /* この試験群では使わない。 */
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
  ): {
    client: RunnerClient;
    resumes: RunnerResumeCommand[];
    readonly emit: ((event: RunnerEvent) => void) | undefined;
  } {
    const resumes: RunnerResumeCommand[] = [];
    const sessions = new Map<string, RunnerManagerState>();
    const holder: { emit?: (event: RunnerEvent) => void } = {};
    const client: RunnerClient = {
      runnerId,
      runnerIdKnown: true,
      workspacePathKnown: true,
      workspacePath,
      async connect(onEvent) {
        holder.emit = onEvent;
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
    return {
      client,
      resumes,
      get emit() {
        return holder.emit;
      },
    };
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

  async function setupRelocated(): Promise<{
    stores: ReturnType<typeof createMemoryStores>;
    runnerA: ReturnType<typeof fakeRunner>;
    runnerB: ReturnType<typeof fakeRunner>;
    pool: ReturnType<typeof createManagerPool>;
    inbox: InboxEvent[];
  }> {
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
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: fake.registry,
      now: () => FIXED_NOW,
    });

    // 存在しない managerId で `abort()` を呼び、名簿の全 runner への `connect()` だけを踏ませる。
    await pool.abort('mgr-does-not-exist');

    return { stores, runnerA, runnerB, pool, inbox };
  }

  async function relocate(s: Awaited<ReturnType<typeof setupRelocated>>): Promise<void> {
    const { stores, runnerB, pool } = s;
    await pool.reattachRunner('runner-b');
    expect(runnerB.resumes.map((c) => c.managerId)).toEqual(['mgr-race']);
    const afterReattach = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    expect(afterReattach?.runnerId).toBe('runner-b');
    expect(afterReattach?.status).toBe('running');
    expect(afterReattach?.lease?.runnerId).toBe('runner-b');
  }

  it('runner-a の最後の累積が、runner-b へ移った後に遅れて届いても、記録済みの分を二重に積まない', async () => {
    const s = await setupRelocated();
    const { stores, runnerA, runnerB } = s;
    runnerA.emit?.(usageEvent(10));
    await settle();
    expect(await costOf(stores)).toBe(10);

    await relocate(s);
    runnerB.emit?.(usageEvent(1));
    await settle();
    expect(await costOf(stores)).toBe(11);

    runnerA.emit?.(usageEvent(10));
    await settle();
    expect(await costOf(stores)).toBe(11);
  });

  it('runner-a が移った後に新しく使った分（累積の増え）は、取りこぼさず増分だけ積む', async () => {
    const s = await setupRelocated();
    const { stores, runnerA, runnerB } = s;
    runnerA.emit?.(usageEvent(10));
    await settle();
    await relocate(s);
    runnerB.emit?.(usageEvent(1));
    await settle();

    runnerA.emit?.(usageEvent(12));
    await settle();
    expect(await costOf(stores)).toBe(13);
  });

  it('runner-b 自身の累積は今までどおり届いた順に積む（古い runner の判定が現役を巻き込まない）', async () => {
    const s = await setupRelocated();
    const { stores, runnerB } = s;
    await relocate(s);
    runnerB.emit?.(usageEvent(3));
    await settle();
    runnerB.emit?.(usageEvent(5));
    await settle();
    expect(await costOf(stores)).toBe(5);
  });

  it('古い runner の前回の累積を覚えていないとき（再起動後など）は積まず、日誌に跡を残す', async () => {
    const s = await setupRelocated();
    const { stores, runnerA, runnerB } = s;
    await relocate(s);
    runnerB.emit?.(usageEvent(1));
    await settle();

    runnerA.emit?.(usageEvent(10));
    await settle();
    expect(await costOf(stores)).toBe(1);
  });

  it('古い runner の累積が前回より減っていたら積まない（その runner 側の数え直し）', async () => {
    const s = await setupRelocated();
    const { stores, runnerA, runnerB } = s;
    runnerA.emit?.(usageEvent(10));
    await settle();
    await relocate(s);
    runnerB.emit?.(usageEvent(1));
    await settle();

    runnerA.emit?.(usageEvent(4));
    await settle();
    expect(await costOf(stores)).toBe(11);
  });

  it('デーモンを再起動（Pool を作り直す。store は同じ）しても、runner-a の遅れた累積は差だけを積む（過大でも取りこぼしでもない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-race', 'runner-a'));

    async function boot() {
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
      const runnerA = fakeRunner('runner-a');
      const runnerB = fakeRunner('runner-b');
      fake.addClient(runnerA.client);
      fake.addClient(runnerB.client);
      const pool = createManagerPool({
        stores,
        post: () => {},
        runners: fake.registry,
        now: () => FIXED_NOW,
      });
      await pool.abort('mgr-does-not-exist');
      return { pool, runnerA, runnerB };
    }

    const before = await boot();
    before.runnerA.emit?.(usageEvent(10));
    await settle();
    expect(await costOf(stores)).toBe(10);
    await before.pool.stop();

    const after = await boot();
    await after.pool.reattachRunner('runner-b');
    after.runnerB.emit?.(usageEvent(1));
    await settle();
    expect(await costOf(stores)).toBe(11);

    after.runnerA.emit?.(usageEvent(12));
    await settle();
    expect(await costOf(stores)).toBe(13);
    await after.pool.stop();
  });
});

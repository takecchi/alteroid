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

describe('#onEvent: 移った後に届く古い runner の出来事', () => {
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
    });

    // 存在しない managerId の abort で connect だけを踏ませる: pool に SSE を張らせる経路がこれしか無く、張らないと emit が得られないため。
    await pool.abort('mgr-does-not-exist');

    await pool.reattachRunner('runner-b');
    expect(runnerB.resumes.map((c) => c.managerId)).toEqual(['mgr-race']);
    const afterReattach = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    expect(afterReattach?.runnerId).toBe('runner-b');
    expect(afterReattach?.status).toBe('running');
    expect(afterReattach?.lease?.runnerId).toBe('runner-b');

    return { stores, runnerA, runnerB, pool, inbox };
  }

  it('runner-b へ移った後に届く runner-a の古い closed は、台帳と貸し出しを巻き戻さない', async () => {
    const { stores, runnerA } = await setupRelocated();

    expect(runnerA.emit).toBeDefined();
    runnerA.emit?.({
      type: 'closed',
      managerId: 'mgr-race',
      status: 'lost',
      reason: 'runner-a が自分で畳んだ（遅延して届いた）',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    expect(after?.status).toBe('running');
    expect(after?.runnerId).toBe('runner-b');
    expect(after?.lease?.runnerId).toBe('runner-b');
    expect(after?.lease?.releasedAt).toBeUndefined();
  });

  it('runner-b へ移った後に届く runner-a の古い resume_failed は、台帳を巻き戻さない', async () => {
    const { stores, runnerA } = await setupRelocated();

    expect(runnerA.emit).toBeDefined();
    runnerA.emit?.({
      type: 'resume_failed',
      managerId: 'mgr-race',
      sessionId: 'sess-before-relocate',
      reason: '前の会話を見つけられなかった（遅延して届いた）',
      recovered: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    expect(after?.status).toBe('running');
    expect(after?.runnerId).toBe('runner-b');
    expect(after?.lease?.runnerId).toBe('runner-b');
    expect(after?.lease?.releasedAt).toBeUndefined();
  });

  it('runner-b へ移った後に届く runner-a の古い report は、台帳の status・lastReport を巻き戻さず受信箱へも回さない', async () => {
    const { stores, runnerA, inbox } = await setupRelocated();
    runnerA.emit?.({
      type: 'report',
      managerId: 'mgr-race',
      status: 'failed',
      text: 'runner-a からの古い報告（遅延して届いた）',
      reportId: 'stale-report-1',
    } as RunnerEvent);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    expect(after?.runnerId).toBe('runner-b');
    expect(after?.status).toBe('running');
    expect(after?.lastReport).toBe('途中まで進めた');
    expect(inbox.filter((e) => JSON.stringify(e).includes('古い報告'))).toEqual([]);
  });

  it('runner-b へ移った後に届く runner-a の古い ask は、waiting_human にせず受信箱へも回さない', async () => {
    const { stores, runnerA, inbox } = await setupRelocated();
    runnerA.emit?.({
      type: 'ask',
      managerId: 'mgr-race',
      requestId: 'stale-ask-1',
      summary: 'runner-a の古い確認',
      kind: 'permission',
    } as RunnerEvent);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    expect(after?.status).toBe('running');
    expect(inbox.filter((e) => JSON.stringify(e).includes('古い確認'))).toEqual([]);
  });

  it('runner-b へ移った後に届く runner-a の古い session は、sessionId を上書きしない', async () => {
    const { stores, runnerA } = await setupRelocated();
    runnerA.emit?.({
      type: 'session',
      managerId: 'mgr-race',
      sessionId: 'sess-stale-from-a',
    } as RunnerEvent);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    expect(after?.runnerId).toBe('runner-b');
    expect(after?.sessionId).toBe('sess-before-relocate');
  });

  it('runner-b へ移った後に届く runner-a の古い session の pluginLoad は控えない。いまの runner-b のは控える（Issue #3816）', async () => {
    const { runnerA, runnerB, pool } = await setupRelocated();
    const stale = { plugins: [{ name: 'stale' }], errors: null };
    const current = { plugins: [{ name: 'current' }], errors: null };
    runnerA.emit?.({
      type: 'session',
      managerId: 'mgr-race',
      sessionId: 'sess-stale-from-a',
      pluginLoad: stale,
    } as RunnerEvent);
    runnerB.emit?.({
      type: 'session',
      managerId: 'mgr-race',
      sessionId: 'sess-from-b',
      pluginLoad: current,
    } as RunnerEvent);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(pool.pluginLoadOf?.('runner-a')).toBeUndefined();
    expect(pool.pluginLoadOf?.('runner-b')).toEqual({
      at: expect.any(String),
      managerId: 'mgr-race',
      pluginLoad: current,
    });
  });

  it('runner-b へ移った後に届く runner-a の古い settled は、確認の取り下げとして受信箱へ回さない', async () => {
    const { runnerA, inbox } = await setupRelocated();
    const before = inbox.length;
    runnerA.emit?.({
      type: 'settled',
      managerId: 'mgr-race',
      requestId: 'stale-ask-2',
    } as RunnerEvent);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(inbox.length).toBe(before);
  });

  it(
    'job.runnerId が名簿に居ない既定値（runner-primary）のままでも、' +
      'いまの runner から届く closed は捨てずに適用する',
    async () => {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-default-id', 'runner-primary'));
      const fake = createFakeRegistry();
      // runner-primary を名簿に足さない: 足すと「別の実在する runner へ移った」と判定され、捨てる側の試験になってしまうため。
      fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
      const runnerA = fakeRunner('runner-a');
      fake.addClient(runnerA.client);
      const inbox: InboxEvent[] = [];
      const pool = createManagerPool({
        stores,
        post: (event) => inbox.push(event),
        runners: fake.registry,
      });

      await pool.abort('mgr-does-not-exist');
      expect(runnerA.emit).toBeDefined();

      runnerA.emit?.({
        type: 'closed',
        managerId: 'mgr-default-id',
        status: 'done',
        reason: '普通に終わった（runner-a 自身から）',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-default-id');
      expect(after?.status).toBe('done');
    },
  );
});

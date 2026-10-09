import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { pidsSaturationFrom } from './runner-protocol.js';
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

describe('#onEvent: closed が pids 飽和の印を名簿へ知らせる', () => {
  function entryOf(label: string, state: RunnerLiveness, runnerId?: string): RunnerEntry {
    return {
      label,
      state,
      ...(runnerId === undefined ? {} : { runnerId }),
      since: '2026-08-01T00:00:00.000Z',
      revision: { status: 'unheard' },
    };
  }

  const signs: [string, string][] = [];

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
      notePidsSaturationSign(runnerId, sign) {
        signs.push([runnerId, sign]);
      },
      pidsSaturationOf(runnerId, pids) {
        const own = signs.filter(([id]) => id === runnerId).map(([, sign]) => sign);
        return pidsSaturationFrom({
          ...(pids === undefined ? {} : { pids }),
          signs: own as ('eagain' | 'fork-denied')[],
        });
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

    // 存在しない managerId の abort で `#ensureConnected()` だけを踏ませる: 素の pool が SSE を張る唯一の経路のため。
    await pool.abort('mgr-does-not-exist');

    await pool.reattachRunner('runner-b');
    expect(runnerB.resumes.map((c) => c.managerId)).toEqual(['mgr-race']);
    const afterReattach = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
    expect(afterReattach?.runnerId).toBe('runner-b');
    expect(afterReattach?.status).toBe('running');
    expect(afterReattach?.lease?.runnerId).toBe('runner-b');

    return { stores, runnerA, runnerB, pool, inbox };
  }

  async function closeWith(event: Partial<Extract<RunnerEvent, { type: 'closed' }>>) {
    signs.length = 0;
    const { runnerB, stores } = await setupRelocated();
    runnerB.emit?.({
      type: 'closed',
      managerId: 'mgr-race',
      status: 'lost',
      reason: '合成した終わり方',
      ...event,
    });
    await vi.waitFor(async () => {
      const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-race');
      expect(job?.status).not.toBe('running');
    });
    return signs.map((entry) => entry.join(':'));
  }

  it('lost で閉じた resume 失敗（systemError.code = EAGAIN）は eagain の印になる（#2626 の経路）', async () => {
    expect(
      await closeWith({
        status: 'lost',
        reason: 'Failed to spawn Claude Code process: spawn claude EAGAIN',
        systemError: { code: 'EAGAIN', errno: -11, syscall: 'spawn claude' },
      }),
    ).toEqual(['runner-b:eagain']);
  });

  it('failed で閉じ、fork 拒否の差分が付いた回（SIGABRT）は fork-denied の印になる', async () => {
    expect(
      await closeWith({
        status: 'failed',
        reason: 'Claude Code process terminated by signal SIGABRT',
        cgroupEvents: { pidsMaxDelta: 14, oomKillDelta: 0 },
      }),
    ).toEqual(['runner-b:fork-denied']);
  });

  it('文字列に EAGAIN とあっても、構造化された code が無ければ印にしない', async () => {
    expect(
      await closeWith({ status: 'lost', reason: 'spawn claude EAGAIN とマネージャーが書いた' }),
    ).toEqual([]);
  });

  it('fork 拒否が0回の差分や、EAGAIN 以外の code は印にしない', async () => {
    expect(
      await closeWith({
        status: 'failed',
        cgroupEvents: { pidsMaxDelta: 0, oomKillDelta: 1 },
        systemError: { code: 'ENOENT' },
      }),
    ).toEqual([]);
  });

  it('印を受けた器は runner_list の材料（runners()）に、resources を頼まなくても飽和として載り、他の器には載らない', async () => {
    signs.length = 0;
    const { runnerB, pool } = await setupRelocated();
    runnerB.emit?.({
      type: 'closed',
      managerId: 'mgr-race',
      status: 'lost',
      reason: '合成した終わり方',
      systemError: { code: 'EAGAIN' },
    });
    await vi.waitFor(() => {
      expect(signs).toEqual([['runner-b', 'eagain']]);
    });

    const overview = await pool.runners();
    const byId = new Map(overview.runners.map((runner) => [runner.runnerId, runner]));
    expect(byId.get('runner-b')?.state).toBe('connected');
    expect(byId.get('runner-b')?.pidsSaturation?.basis).toEqual([{ kind: 'eagain', count: 1 }]);
    expect(byId.get('runner-a')?.pidsSaturation).toBeUndefined();
    expect(pool.runnerPidsSaturation?.('runner-b')?.basis).toEqual([{ kind: 'eagain', count: 1 }]);
    expect(pool.runnerPidsSaturation?.('runner-a')).toBeUndefined();
  });

  it('done で正常に終わった回は、印があっても数えない', async () => {
    expect(await closeWith({ status: 'done', cgroupEvents: { pidsMaxDelta: 3 } })).toEqual([]);
  });
});

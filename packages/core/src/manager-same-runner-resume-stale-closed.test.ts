import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { RunnerHttpError } from './runner-protocol.js';
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
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('同じ runner への復帰の最中に届く closed', () => {
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
    sessionGeneration?: string,
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
      async resume(command): Promise<{ cwd?: string; sessionGeneration?: string }> {
        resumes.push(command);
        sessions.set(command.managerId, {
          managerId: command.managerId,
          status: 'running',
          cwd: command.cwd,
          request: command.request,
          waiting: [],
          sessionId: command.sessionId,
        });
        return sessionGeneration === undefined ? {} : { sessionGeneration };
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

  it('同じ runner-a への復帰 resume が飛んでいる最中に runner-a の closed(lost) が届き、resume が受理されたなら、台帳は running のまま新しいセッションを追う', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-same', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredResume = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalResume = runnerA.client.resume.bind(runnerA.client);
    runnerA.client.resume = async (command) => {
      entered();
      await gate;
      return originalResume(command);
    };
    fake.addClient(runnerA.client);
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
    await pool.abort('mgr-does-not-exist');

    const reattach = pool.reattachRunner('runner-a');
    await enteredResume;
    runnerA.emit?.({
      type: 'closed',
      managerId: 'mgr-same',
      status: 'lost',
      reason: '旧セッションが畳まれた',
    });
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    release();
    await reattach;

    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-same');
    expect({
      status: after?.status,
      sessionsOnA: (await runnerA.client.list()).map((s) => s.managerId),
    }).toEqual({ status: 'running', sessionsOnA: ['mgr-same'] });
    await pool.stop();
  });
  it('同じ runner-a への復帰 resume が失敗したなら、窓の間に届いた closed(lost) は従来どおり lost として効く（預かって捨てない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-same', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredResume = new Promise<void>((resolve) => {
      entered = resolve;
    });
    runnerA.client.resume = async () => {
      entered();
      await gate;
      // 一時的な失敗（再挑戦の対象）。台帳を lost にするのは resume の失敗ではなく、窓の間に届いた closed だけ。
      throw new RunnerHttpError('unavailable', 503);
    };
    fake.addClient(runnerA.client);
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
    await pool.abort('mgr-does-not-exist');

    const reattach = pool.reattachRunner('runner-a');
    await enteredResume;
    runnerA.emit?.({
      type: 'closed',
      managerId: 'mgr-same',
      status: 'lost',
      reason: 'runner-a が畳んだ（resume は結局受理されない）',
    });
    // 実時間では待たない。
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    release();
    await reattach;

    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-same');
    expect(after?.status).toBe('lost');
    await pool.stop();
  });

  async function resumedOnSameRunner(options: {
    generation?: string;
    inWindow?: RunnerEvent[];
  }): Promise<{
    pool: ReturnType<typeof createManagerPool>;
    stores: ReturnType<typeof createMemoryStores>;
    runnerA: ReturnType<typeof fakeRunner>;
  }> {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-same', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a', '/work/project', options.generation);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredResume = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalResume = runnerA.client.resume.bind(runnerA.client);
    runnerA.client.resume = async (command) => {
      entered();
      await gate;
      return originalResume(command);
    };
    fake.addClient(runnerA.client);
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
    await pool.abort('mgr-does-not-exist');
    const reattach = pool.reattachRunner('runner-a');
    await enteredResume;
    for (const event of options.inWindow ?? []) runnerA.emit?.(event);
    // 実時間では待たない。
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    release();
    await reattach;
    return { pool, stores, runnerA };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  const lostClosed = (sessionGeneration?: string): RunnerEvent => ({
    type: 'closed',
    managerId: 'mgr-same',
    status: 'lost',
    reason: 'セッションが畳まれた',
    ...(sessionGeneration === undefined ? {} : { sessionGeneration }),
  });

  describe('セッションの世代（Issue #3170）で、窓の外に届く古い出来事を区別する', () => {
    it('resume の応答の後に届いた、古い世代のセッションの closed(lost) は、台帳を lost にしない（窓の外。#3159 の残り）', async () => {
      const { pool, stores, runnerA } = await resumedOnSameRunner({ generation: 'gen-new' });
      runnerA.emit?.(lostClosed('gen-old'));
      await settle();
      const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-same');
      expect(after?.status).toBe('running');
      await pool.stop();
    });

    it('新しい世代の closed(lost) は、従来どおり台帳を lost にする', async () => {
      const { pool, stores, runnerA } = await resumedOnSameRunner({ generation: 'gen-new' });
      runnerA.emit?.(lostClosed('gen-new'));
      await settle();
      const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-same');
      expect(after?.status).toBe('lost');
      await pool.stop();
    });

    it('世代を持たない closed(lost) は、従来どおり lost にする（古い runner との後方互換）', async () => {
      const { pool, stores, runnerA } = await resumedOnSameRunner({ generation: 'gen-new' });
      runnerA.emit?.(lostClosed());
      await settle();
      const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-same');
      expect(after?.status).toBe('lost');
      await pool.stop();
    });

    it('resume の応答が世代を名乗らない（古い runner）なら、追っている世代を持たず、世代付きの closed(lost) も従来どおり効く', async () => {
      const { pool, stores, runnerA } = await resumedOnSameRunner({});
      runnerA.emit?.(lostClosed('gen-whatever'));
      await settle();
      const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-same');
      expect(after?.status).toBe('lost');
      await pool.stop();
    });

    it('窓の間に届いた新しい世代の closed(lost) は、窓の「古い出来事」扱いで捨てられず、lost にする', async () => {
      const { pool, stores } = await resumedOnSameRunner({
        generation: 'gen-new',
        inWindow: [lostClosed('gen-new')],
      });
      await settle();
      const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-same');
      expect(after?.status).toBe('lost');
      await pool.stop();
    });

    it('窓の間に届いた古い世代の closed(lost) は、これまでどおり捨てて running のまま', async () => {
      const { pool, stores } = await resumedOnSameRunner({
        generation: 'gen-new',
        inWindow: [lostClosed('gen-old')],
      });
      const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-same');
      expect(after?.status).toBe('running');
      await pool.stop();
    });

    it('古い世代の report は、台帳の lastReport を書き換えない。新しい世代・世代なしの report は従来どおり書く', async () => {
      const { pool, stores, runnerA } = await resumedOnSameRunner({ generation: 'gen-new' });
      const report = (text: string, sessionGeneration?: string): RunnerEvent => ({
        type: 'report',
        managerId: 'mgr-same',
        status: 'done',
        text,
        ...(sessionGeneration === undefined ? {} : { sessionGeneration }),
      });
      const lastReport = async (): Promise<string | undefined> =>
        (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-same')?.lastReport;
      runnerA.emit?.(report('古いセッションの報告', 'gen-old'));
      await settle();
      expect(await lastReport()).toBe('途中まで進めた');
      runnerA.emit?.(report('新しいセッションの報告', 'gen-new'));
      await settle();
      expect(await lastReport()).toBe('新しいセッションの報告');
      runnerA.emit?.(report('世代なしの報告'));
      await settle();
      expect(await lastReport()).toBe('世代なしの報告');
      await pool.stop();
    });
  });
});

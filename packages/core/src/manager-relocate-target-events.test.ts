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

describe('移送の最中に届く移送先 runner 自身の出来事', () => {
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

  async function setup(resume: 'accepted' | 'refused' = 'accepted') {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-target', 'runner-a', {
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
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredResume = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalResume = runnerB.client.resume.bind(runnerB.client);
    runnerB.client.resume = async (command) => {
      entered();
      await gate;
      if (resume === 'refused') throw new RunnerHttpError('unavailable', 503);
      return originalResume(command);
    };
    fake.addClient(runnerA.client);
    fake.addClient(runnerB.client);
    const inbox: unknown[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: fake.registry,
    });
    await pool.abort('mgr-does-not-exist');
    const reattach = pool.reattachRunner('runner-b');
    await enteredResume;
    const drain = async (): Promise<void> => {
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    return { stores, pool, runnerB, release, reattach, drain, inbox };
  }

  it('移送先 runner-b が resume の応答より先に流した report は、runner-b 自身の出来事として台帳へ効く', async () => {
    const { stores, pool, runnerB, release, reattach, drain } = await setup();
    runnerB.emit?.({
      type: 'report',
      managerId: 'mgr-target',
      status: 'done',
      text: '移送先で最初の報告',
    });
    await drain();
    release();
    await reattach;
    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-target');
    expect(after?.lastReport).toBe('移送先で最初の報告');
    await pool.stop();
  });

  it('移送先 runner-b が resume の応答より先に流した closed(failed) は、runner-b 自身の出来事として台帳へ効く', async () => {
    const { stores, pool, runnerB, release, reattach, drain } = await setup();
    runnerB.emit?.({
      type: 'closed',
      managerId: 'mgr-target',
      status: 'failed',
      reason: '移送先のセッションが起動直後に落ちた',
    });
    await drain();
    release();
    await reattach;
    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-target');
    expect(after?.status).toBe('failed');
    await pool.stop();
  });

  const askEvent = {
    type: 'ask',
    managerId: 'mgr-target',
    requestId: 'target-ask-window',
    kind: 'permission',
    summary: 'Bash の実行許可（runner-b 最初の確認）',
  } as RunnerEvent;
  const askCount = (inbox: unknown[]): number =>
    (inbox as { text?: string }[]).filter((event) =>
      (event.text ?? '').includes('runner-b 最初の確認'),
    ).length;

  it('移送先 runner-b が resume の応答より先に流した ask は、受理の後にクローンへ配られ、待ちへ積まれる', async () => {
    const { stores, pool, runnerB, release, reattach, drain, inbox } = await setup();
    runnerB.emit?.(askEvent);
    await drain();
    release();
    await reattach;
    await drain();
    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-target');
    expect({ status: after?.status, runnerId: after?.runnerId, toClone: askCount(inbox) }).toEqual({
      status: 'waiting_human',
      runnerId: 'runner-b',
      toClone: 1,
    });
    await pool.stop();
  });

  it('移送が失敗した（runner-b の resume が 503）なら、窓の間に runner-b から届いた report は台帳へ効かない', async () => {
    const { stores, pool, runnerB, release, reattach, drain, inbox } = await setup('refused');
    runnerB.emit?.({
      type: 'report',
      managerId: 'mgr-target',
      status: 'done',
      text: '引き取っていない移送先の報告',
    });
    runnerB.emit?.(askEvent);
    await drain();
    release();
    await reattach;
    await drain();
    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-target');
    expect({
      status: after?.status,
      runnerId: after?.runnerId,
      lastReport: after?.lastReport,
      asks: askCount(inbox),
      reports: (inbox as { text?: string }[]).filter((event) =>
        (event.text ?? '').includes('引き取っていない移送先の報告'),
      ).length,
    }).toEqual({
      status: 'running',
      runnerId: 'runner-a',
      lastReport: '途中まで進めた',
      asks: 0,
      reports: 0,
    });
    await pool.stop();
  });
});

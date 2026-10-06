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

describe('移送の最中に届く元の runner の closed', () => {
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

  /**
   * `manager-abort-moved.test.ts` の `fakeRunner` と同じ形だが、`connect()` が
   * 受け取った `onEvent` を `emit` として外へ持ち出す（テストから runner 発の
   * 出来事を流すため）。
   */
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

  it('runner-b への resume が飛んでいる最中に runner-a の遅れた closed(lost) が届いても、resume が受理されたなら台帳は running になる', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-inflight', 'runner-a', {
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
      return originalResume(command);
    };
    fake.addClient(runnerA.client);
    fake.addClient(runnerB.client);
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: fake.registry,
    });
    await pool.abort('mgr-does-not-exist');

    const reattach = pool.reattachRunner('runner-b');
    await enteredResume;
    // resume が runner-b へ飛んでいる最中（台帳の宛先はまだ runner-a）に、
    // runner-a が自分の畳みを遅れて名乗る。
    runnerA.emit?.({
      type: 'closed',
      managerId: 'mgr-inflight',
      status: 'lost',
      reason: 'runner-a が自分で畳んだ（遅延して届いた）',
    });
    // 実時間では待たない（#2146）。closed の処理（台帳の読み書きはメモリのストア）を、
    // 非同期の段を流しきることで終わらせてから resume を通す。
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    release();
    await reattach;

    expect(runnerB.resumes.map((c) => c.managerId)).toEqual(['mgr-inflight']);
    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-inflight');
    expect({
      status: after?.status,
      runnerId: after?.runnerId,
      sessionsOnB: (await runnerB.client.list()).map((s) => s.managerId),
    }).toEqual({ status: 'running', runnerId: 'runner-b', sessionsOnB: ['mgr-inflight'] });
    // runner-b は resume を受理して走っている。台帳が lost のままなら誰も走っていない仕事に見える。
    expect(after?.status).toBe('running');
    await pool.stop();
  });

  it('移送が失敗した（runner-b の resume が 503 で落ちた）なら、窓の間に届いた runner-a の closed(lost) は従来どおり台帳へ効く', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-inflight', 'runner-a', {
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
    runnerB.client.resume = async () => {
      entered();
      await gate;
      throw new RunnerHttpError('unavailable', 503);
    };
    fake.addClient(runnerA.client);
    fake.addClient(runnerB.client);
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: fake.registry,
    });
    await pool.abort('mgr-does-not-exist');

    const reattach = pool.reattachRunner('runner-b');
    await enteredResume;
    // resume が runner-b へ飛んでいる最中（台帳の宛先はまだ runner-a）に、
    // runner-a が自分の畳みを遅れて名乗る。
    runnerA.emit?.({
      type: 'closed',
      managerId: 'mgr-inflight',
      status: 'lost',
      reason: 'runner-a が自分で畳んだ（遅延して届いた）',
    });
    // 実時間では待たない（#2146）。closed の処理（台帳の読み書きはメモリのストア）を、
    // 非同期の段を流しきることで終わらせてから resume を通す。
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    release();
    await reattach;

    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-inflight');
    expect({ status: after?.status, runnerId: after?.runnerId }).toEqual({
      status: 'lost',
      runnerId: 'runner-a',
    });
    await pool.stop();
  });
});

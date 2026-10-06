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

describe('併存の見送り（#refuseRelocationsBeforeGate）と abort の交差', () => {
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

  it('同じ runner-a への復帰 resume が飛んでいる最中に abort が stopped を書き、その resume が 4xx で断られても、台帳は stopped のまま', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-abort', 'runner-a'));
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
      throw new RunnerHttpError('bad request', 400);
    };
    fake.addClient(runnerA.client);
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
    await pool.abort('mgr-does-not-exist');

    const reattach = pool.reattachRunner('runner-a');
    await enteredResume;
    const aborted = await pool.abort('mgr-abort', '人間が止めた');
    expect(aborted.outcome).toBe('stopped');
    release();
    await reattach;

    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-abort');
    expect(after?.status).toBe('stopped');
    await pool.stop();
  });
  it('併存の見送りが2本目の委譲を lost に確定する前に abort が stopped を書いたなら、台帳は stopped のまま', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-a', 'runner-x'));
    await stores.jobs.putJob(jobWith('mgr-b', 'runner-x', { sessionId: 'sess-b' }));
    const fake = createFakeRegistry();
    // 元の宛先 runner-x は lost。移送先候補 runner-a は同じ名前の器が 2 台併存している。
    fake.entries.push(entryOf('runner-x', 'lost', 'runner-x'));
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerX = fakeRunner('runner-x');
    const runnerA = fakeRunner('runner-a');
    fake.addClient(runnerX.client);
    fake.addClient(runnerA.client);

    // mgr-a を lost に確定して書き込んだ直後（＝ループが mgr-b に着く前）に、mgr-b の abort を最後まで通す。
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
    let abortDone: Promise<unknown> | undefined;
    const originalPut = stores.jobs.putJob.bind(stores.jobs);
    stores.jobs.putJob = async (job) => {
      await originalPut(job);
      if (job.id === 'mgr-a' && job.status === 'lost' && abortDone === undefined) {
        abortDone = pool.abort('mgr-b', '人間が止めた');
        await abortDone;
      }
    };

    await pool.reattachRunner('runner-a');
    await abortDone;

    expect(((await abortDone) as { outcome: string }).outcome).toBe('stopped');
    const byId = Object.fromEntries((await stores.jobs.listJobs()).map((j) => [j.id, j.status]));
    expect(byId).toEqual({ 'mgr-a': 'lost', 'mgr-b': 'stopped' });
    await pool.stop();
  });
  it('移送先へ移すときの no-session（セッションが無い）で lost に確定する直前に abort が stopped を書いたなら、台帳は stopped のまま', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-ns', 'runner-a', { sessionId: undefined }));
    const fake = createFakeRegistry();
    // 元の宛先 runner-a は lost、移送先 runner-b が名乗った。no-session はその場で確定に進む。
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerA = fakeRunner('runner-a');
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerA.client);
    fake.addClient(runnerB.client);

    // 「確定する」と日誌に書いた直後（＝ `#confirmLost` へ入る前）に、abort を最後まで通す。
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
    let abortDone: Promise<{ outcome: string }> | undefined;
    const originalAppend = stores.journal.append.bind(stores.journal);
    stores.journal.append = async (input) => {
      const written = await originalAppend(input);
      if (
        abortDone === undefined &&
        JSON.stringify(input).includes('戻せなかったものとして確定する')
      ) {
        abortDone = pool.abort('mgr-ns', '人間が止めた');
        await abortDone;
      }
      return written;
    };
    await pool.abort('mgr-does-not-exist');

    await pool.reattachRunner('runner-b');

    expect((await abortDone)?.outcome).toBe('stopped');
    const after = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-ns');
    expect(after?.status).toBe('stopped');
    await pool.stop();
  });
});

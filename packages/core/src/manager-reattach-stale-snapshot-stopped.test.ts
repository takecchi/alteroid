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
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('runner の取り直し（reattach）と abort の交差（listJobs の古い写し）', () => {
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

  it('runner の取り直し（reattach）が先の委譲を resume している最中に、後ろの委譲を人間が止め切っても、その委譲を起こし直さない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-first', 'runner-a'));
    await stores.jobs.putJob(jobWith('mgr-second', 'runner-a'));
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
    const plainResume = runnerA.client.resume.bind(runnerA.client);
    runnerA.client.resume = async (command) => {
      if (command.managerId === 'mgr-first') {
        entered();
        await gate;
      }
      return plainResume(command);
    };
    fake.addClient(runnerA.client);
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
    await pool.abort('mgr-does-not-exist');

    // runner が再起動して hello が来た。1本目の resume が遅い（実運用では数秒かかる）。
    const reattach = pool.reattachRunner('runner-a');
    await enteredResume;
    // その間に人間が、まだ順番の来ていない2本目を止める。runner に居ないので stop は即座に確定する。
    const aborted = await pool.abort('mgr-second', '人間が止めた');
    expect(aborted.outcome).toBe('stopped');
    expect((await stores.jobs.listJobs()).find((j) => j.id === 'mgr-second')?.status).toBe(
      'stopped',
    );
    release();
    await reattach;

    expect(runnerA.resumes.map((command) => command.managerId)).toEqual(['mgr-first']);
    expect((await stores.jobs.listJobs()).find((j) => j.id === 'mgr-second')?.status).toBe(
      'stopped',
    );
  });

  it('起動時の引き取り（restore）が先の委譲を resume している最中に、後ろの委譲を人間が止め切っても、その委譲を起こし直さない（#3603 の同じ型）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-first', 'runner-a'));
    await stores.jobs.putJob(jobWith('mgr-second', 'runner-a'));
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
    const plainResume = runnerA.client.resume.bind(runnerA.client);
    runnerA.client.resume = async (command) => {
      if (command.managerId === 'mgr-first') {
        entered();
        await gate;
      }
      return plainResume(command);
    };
    fake.addClient(runnerA.client);
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });

    // デーモンが起動して引き取りが走る。1本目の resume が遅い。
    const restoring = pool.restore();
    await enteredResume;
    // その間に人間が、まだ順番の来ていない2本目を止める。台帳は stopped になる。
    const aborted = await pool.abort('mgr-second', '人間が止めた');
    expect(aborted.outcome).toBe('stopped');
    expect((await stores.jobs.listJobs()).find((j) => j.id === 'mgr-second')?.status).toBe(
      'stopped',
    );
    release();
    await restoring;

    expect(runnerA.resumes.map((command) => command.managerId)).toEqual(['mgr-first']);
    expect((await stores.jobs.listJobs()).find((j) => j.id === 'mgr-second')?.status).toBe(
      'stopped',
    );
  });
});

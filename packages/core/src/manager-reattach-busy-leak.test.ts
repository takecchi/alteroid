import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('reattach と別の契機の resume が重なる（busy）', () => {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  /** send の resume を gate で止め、その間に reattach を busy で抜けさせる共通の組み立て。 */
  async function setupBusy(outcomeAfterGate: 'ok' | 'unavailable' | 'never') {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-busy', 'runner-a'));
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
    const counts = { resumes: 0, lists: 0 };
    runnerA.client.resume = async (command) => {
      counts.resumes += 1;
      if (counts.resumes === 1) {
        entered();
        await gate;
        if (outcomeAfterGate === 'never') await new Promise<void>(() => {});
        if (outcomeAfterGate === 'unavailable') throw new RunnerHttpError('unavailable', 503);
      }
      return originalResume(command);
    };
    const originalList = runnerA.client.list.bind(runnerA.client);
    runnerA.client.list = async () => {
      counts.lists += 1;
      return originalList();
    };
    fake.addClient(runnerA.client);
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
    const sending = pool.send('mgr-busy', '続きを').catch(() => undefined);
    await enteredResume;
    await pool.reattachRunner('runner-a');
    return { pool, stores, runnerA, counts, release, sending };
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  it('busy の数えは、委譲が running でなくなって reattach が素通りしても消えず、後の busy の上限を縮める', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { pool, stores, runnerA } = await setupBusy('never');
    const capReached = async () =>
      JSON.stringify(await stores.journal.list({ types: ['decision'] })).includes(
        '取り直しの予約を止めた',
      );
    // busy 2 回目・3 回目（setupBusy の 1 回と合わせて数えは 3）。
    await pool.reattachRunner('runner-a');
    await pool.reattachRunner('runner-a');
    // 委譲が畳まれる（closed done）。reattach は status で素通りし、数えを消さない。
    runnerA.emit?.({ type: 'closed', managerId: 'mgr-busy', status: 'done', reason: '終えた' });
    await flush();
    const afterClose = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-busy')?.status;
    await pool.reattachRunner('runner-a');
    // 後で同じ委譲がまた running になり、また busy に当たる。素の状態なら 3 回の busy で上限には達しない。
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-busy');
    if (job) await stores.jobs.putJob({ ...job, status: 'running' });
    await pool.reattachRunner('runner-a');
    await pool.reattachRunner('runner-a');
    await pool.reattachRunner('runner-a');
    expect({ afterClose, capReachedAfter3FreshBusy: await capReached() }).toEqual({
      afterClose: 'done',
      capReachedAfter3FreshBusy: false,
    });
    await pool.stop();
  });

  it('abort で止めた委譲の busy の数えも消え、後の busy の上限を縮めない（#3265）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { pool, stores } = await setupBusy('never');
    const capReached = async () =>
      JSON.stringify(await stores.journal.list({ types: ['decision'] })).includes(
        '取り直しの予約を止めた',
      );
    // busy 2 回目・3 回目（setupBusy の 1 回と合わせて数えは 3）。
    await pool.reattachRunner('runner-a');
    await pool.reattachRunner('runner-a');
    const aborted = await pool.abort('mgr-busy', '止める', 'clone');
    const afterAbort = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-busy')?.status;
    // 後で同じ委譲がまた running になり、また busy に当たる。素の状態なら 3 回の busy で上限には達しない。
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-busy');
    if (job) await stores.jobs.putJob({ ...job, status: 'running' });
    await pool.reattachRunner('runner-a');
    await pool.reattachRunner('runner-a');
    await pool.reattachRunner('runner-a');
    expect({
      outcome: aborted.outcome,
      afterAbort,
      capReachedAfter3FreshBusy: await capReached(),
    }).toEqual({ outcome: 'stopped', afterAbort: 'stopped', capReachedAfter3FreshBusy: false });
    await pool.stop();
  });

  it('対照: 素の委譲は busy 5 回（setupBusy の 1 回 + reattach 4 回）では上限に達しない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { pool, stores } = await setupBusy('never');
    for (let i = 0; i < 4; i += 1) await pool.reattachRunner('runner-a');
    const text = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(text.includes('取り直しの予約を止めた')).toBe(false);
    await pool.stop();
  });
});

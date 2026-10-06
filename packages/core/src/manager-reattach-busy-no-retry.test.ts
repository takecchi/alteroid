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

  it('別の契機（manager_send の resume）が飛んでいる最中の reattach が busy で抜け、その resume が一時的に失敗したなら、この委譲の取り直しは予約され直す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    let calls = 0;
    runnerA.client.resume = async (command) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await gate;
        // 一時的な失敗（再挑戦の対象）。
        throw new RunnerHttpError('unavailable', 503);
      }
      return originalResume(command);
    };
    fake.addClient(runnerA.client);
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });

    const sending = pool.send('mgr-busy', '続きを').catch(() => undefined);
    await enteredResume;
    // send の resume が飛んでいる最中に runner-a が名乗る（hello 相当）。resume は busy で返る。
    await pool.reattachRunner('runner-a');
    release();
    await sending;
    // 取り直しの梯子の最大間隔（30 秒）より先まで進める。実時間では待たない（#2146）。
    for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(31_000);
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));

    expect({
      resumeCalls: calls,
      sessionsOnA: (await runnerA.client.list()).map((s) => s.managerId),
    }).toEqual({ resumeCalls: 2, sessionsOnA: ['mgr-busy'] });
    await pool.stop();
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

  it('別の契機の resume が成功したなら、取り直しは余計な resume を投げない（alive に居る）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { pool, runnerA, counts, release, sending } = await setupBusy('ok');
    release();
    await sending;
    for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(31_000);
    await flush();
    expect({
      resumeCalls: counts.resumes,
      sessionsOnA: (await runnerA.client.list()).map((s) => s.managerId),
    }).toEqual({ resumeCalls: 1, sessionsOnA: ['mgr-busy'] });
    await pool.stop();
  });

  it('busy が続いても上限で止まり、取り直しの試行と予約が際限なく増えない（止まったことは日誌に残る）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { pool, stores, counts } = await setupBusy('never');
    // 相手の resume は終わらない。上限（5 回 ≒ 31 秒）を十分に越えて進める。
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(31_000);
    await flush();
    const listsAfterCap = counts.lists;
    const timersAfterCap = vi.getTimerCount();
    // さらに長く進めても、試行（list の往復）も予約（タイマー）も増えない。
    for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(31_000);
    await flush();
    expect({
      resumeCalls: counts.resumes,
      listsGrew: counts.lists - listsAfterCap,
      timersGrew: vi.getTimerCount() - timersAfterCap,
      boundedLists: listsAfterCap <= 10,
    }).toEqual({ resumeCalls: 1, listsGrew: 0, timersGrew: 0, boundedLists: true });
    const journal = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(journal).toContain('取り直しの予約を止めた');
    await pool.stop();
  });
});

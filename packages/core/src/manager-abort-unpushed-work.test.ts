import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEntry,
  RunnerLiveness,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRegistry,
  RunnerResumeCommand,
  UnpushedWorkResult,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

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
): { client: RunnerClient; resumes: RunnerResumeCommand[] } {
  const resumes: RunnerResumeCommand[] = [];
  const sessions = new Map<string, { managerId: string }>();
  const client: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath,
    async connect() {
      /* この試験群では使わない。 */
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      resumes.push(command);
      sessions.set(command.managerId, { managerId: command.managerId });
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
      return [...sessions.values()].map((s) => ({
        managerId: s.managerId,
        status: 'running' as const,
        cwd: workspacePath,
        request: '続きをやって',
        waiting: [],
      }));
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
  return { client, resumes };
}

function jobWith(id: string, runnerId: string | undefined, overrides: Partial<Job> = {}): Job {
  return {
    id,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running',
    summary: '走行中の委譲',
    request: '続きをやって',
    cwd: '/work/project',
    sessionId: 'sess-before-abort',
    lastReport: '途中まで進めた',
    ...(runnerId === undefined ? {} : { runnerId }),
    ...overrides,
  };
}

function setup(stores: ReturnType<typeof createMemoryStores>, registry: RunnerRegistry) {
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({ stores, post: (event) => inbox.push(event), runners: registry });
  return { pool, inbox };
}

describe('abort() が runner.stop(managerId) の直前に unpushedWork() を取る（Issue #1266 残り2）', () => {
  it('1. runner.stop() より前に unpushedWork() が呼ばれ、観測が source: stop で台帳に残る（force:true 相当）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-abort-unpushed', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    await runnerA.client.resume({
      managerId: 'mgr-abort-unpushed',
      request: '続きをやって',
      cwd: '/work/project',
      sessionId: 'sess-before-abort',
    });

    const calls: string[] = [];
    const result: UnpushedWorkResult = {
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/abort-observed-before-stop' }],
    };
    runnerA.client.unpushedWork = async (managerId) => {
      calls.push(`unpushedWork:${managerId}`);
      return result;
    };
    const originalStop = runnerA.client.stop;
    runnerA.client.stop = async (managerId: string) => {
      calls.push(`stop:${managerId}`);
      return originalStop(managerId);
    };
    fake.addClient(runnerA.client);
    const { pool } = setup(stores, fake.registry);

    const result2 = await pool.abort('mgr-abort-unpushed', '429 の再試行', 'clone');
    expect(result2.outcome).toBe('stopped');

    // 順序そのものが要点: unpushedWork を、生きて答えられる最後の機会（stop より前）に取る。
    expect(calls).toEqual(['unpushedWork:mgr-abort-unpushed', 'stop:mgr-abort-unpushed']);

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-abort-unpushed');
    expect(job?.lastUnpushedWorkObservation).toMatchObject({
      kind: 'observed',
      source: 'stop',
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/abort-observed-before-stop' }],
    });

    await pool.stop();
  });

  it('2. by: "human"（既定。Web UI / DELETE /managers/:id 相当）でも同じ形で残る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-abort-human', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    await runnerA.client.resume({
      managerId: 'mgr-abort-human',
      request: '続きをやって',
      cwd: '/work/project',
      sessionId: 'sess-before-abort',
    });
    runnerA.client.unpushedWork = async () => ({
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'fix/human-stop' }],
    });
    fake.addClient(runnerA.client);
    const { pool } = setup(stores, fake.registry);

    await pool.abort('mgr-abort-human');

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-abort-human');
    expect(job?.lastUnpushedWorkObservation).toMatchObject({ kind: 'observed', source: 'stop' });

    await pool.stop();
  });

  it('3. by: "auto-fold" でも同じ形で残る（安全弁の source: auto-fold とは別に、止める直前の観測を取り直す）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-abort-autofold', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    await runnerA.client.resume({
      managerId: 'mgr-abort-autofold',
      request: '続きをやって',
      cwd: '/work/project',
      sessionId: 'sess-before-abort',
    });
    runnerA.client.unpushedWork = async () => ({
      cwd: '/work/project',
      worktrees: [],
    });
    fake.addClient(runnerA.client);
    const { pool } = setup(stores, fake.registry);

    await pool.abort('mgr-abort-autofold', 'pids 逼迫を受けてデーモンが自動で畳んだ', 'auto-fold');

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-abort-autofold');
    expect(job?.lastUnpushedWorkObservation).toMatchObject({ kind: 'observed', source: 'stop' });

    await pool.stop();
  });

  it('4. unpushedWork() の応答が失敗しても、確かめた停止の判定は変わらない（kind: unavailable として残る）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-abort-unpushed-fail', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    await runnerA.client.resume({
      managerId: 'mgr-abort-unpushed-fail',
      request: '続きをやって',
      cwd: '/work/project',
      sessionId: 'sess-before-abort',
    });
    runnerA.client.unpushedWork = async () => {
      throw new Error('runner が答えなかった');
    };
    fake.addClient(runnerA.client);
    const { pool } = setup(stores, fake.registry);

    const result = await pool.abort('mgr-abort-unpushed-fail', '確認', 'clone');

    expect(result.outcome).toBe('stopped');

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-abort-unpushed-fail');
    expect(job?.status).toBe('stopped');
    expect(job?.lastUnpushedWorkObservation).toMatchObject({ kind: 'unavailable', source: 'stop' });

    await pool.stop();
  });
});

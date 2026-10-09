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
import type { InboxEvent, Job, JobLease } from './schema.js';
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
    vacate(runnerId) {
      for (const entry of entries) {
        if (entry.runnerId === runnerId) entry.state = 'vacating';
      }
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
  sessions.set('__seed__', { managerId: '__seed__' });
  sessions.delete('__seed__');
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
    sessionId: 'sess-before-vacate',
    lastReport: '途中まで進めた',
    ...(runnerId === undefined ? {} : { runnerId }),
    ...overrides,
  };
}

function recentLease(runnerId: string, fence = 4): JobLease {
  const now = Date.now();
  return {
    runnerId,
    fence,
    grantedAt: new Date(now - 2_000).toISOString(),
    seenAt: new Date(now - 1_000).toISOString(),
    ttlMs: 10 * 60_000,
  };
}

function setup(stores: ReturnType<typeof createMemoryStores>, registry: RunnerRegistry) {
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({ stores, post: (event) => inbox.push(event), runners: registry });
  return { pool, inbox };
}

describe('vacate が runner.stop() の直前に unpushedWork() を取る（Issue #1266 候補(2)）', () => {
  it('1. runner.stop() より前に unpushedWork() が呼ばれ、観測が台帳に残る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-vacate-unpushed', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    // `vacate()` は `list()` に載っている走行中のものだけに握手するので、先に `resume` しておく。
    await runnerA.client.resume({
      managerId: 'mgr-vacate-unpushed',
      request: '続きをやって',
      cwd: '/work/project',
      sessionId: 'sess-before-vacate',
    });

    const calls: string[] = [];
    const result: UnpushedWorkResult = {
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/vacate-observed-before-stop' }],
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

    await pool.vacate('runner-a');

    // 順序そのものが要点: unpushedWork を、生きて答えられる最後の機会（stop より前）に取る。
    expect(calls).toEqual(['unpushedWork:mgr-vacate-unpushed', 'stop:mgr-vacate-unpushed']);

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-vacate-unpushed');
    expect(job?.lastUnpushedWorkObservation).toMatchObject({
      kind: 'observed',
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/vacate-observed-before-stop' }],
    });

    await pool.stop();
  });

  it('2. unpushedWork() の応答が失敗しても、確かめた停止・貸し出しの解放・移送は変わらない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(
      jobWith('mgr-vacate-unpushed-fail', 'runner-a', {
        lease: { ...recentLease('runner-a'), instanceId: 'inst-a' },
      }),
    );
    const fake = createFakeRegistry();
    fake.entries.push({ ...entryOf('runner-a', 'connected', 'runner-a'), instanceId: 'inst-a' });
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    const runnerA = fakeRunner('runner-a');
    await runnerA.client.resume({
      managerId: 'mgr-vacate-unpushed-fail',
      request: '続きをやって',
      cwd: '/work/project',
      sessionId: 'sess-before-vacate',
    });
    runnerA.client.unpushedWork = async () => {
      throw new Error('runner が答えなかった');
    };
    const runnerB = fakeRunner('runner-b');
    fake.addClient(runnerA.client);
    fake.addClient(runnerB.client);
    const { pool } = setup(stores, fake.registry);

    await pool.vacate('runner-a');

    await expect.poll(() => runnerB.resumes.length, { timeout: 2000 }).toBe(1);

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-vacate-unpushed-fail');
    expect(job?.runnerId).toBe('runner-b');
    expect(job?.status).toBe('running');
    expect(job?.lastUnpushedWorkObservation).toMatchObject({ kind: 'unavailable' });

    await pool.stop();
  });
});

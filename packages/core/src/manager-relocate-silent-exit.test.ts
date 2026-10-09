import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { RunnerHttpError } from './runner-protocol.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEntry,
  RunnerLiveness,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRegistry,
  RunnerResumeCommand,
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

// `vacate` は本物と同じく `entries` の該当行を `'vacating'` へ倒す: 手で先に置く形と
// `pool.vacate()` 経由の形を同じ偽物で試せるようにするため。
function createFakeRegistry(): {
  registry: RunnerRegistry;
  entries: RunnerEntry[];
  addClient: (client: RunnerClient) => void;
  gotten: string[];
} {
  const clients = new Map<string, RunnerClient>();
  const entries: RunnerEntry[] = [];
  const gotten: string[] = [];
  const registry: RunnerRegistry = {
    async list() {
      return [...clients.values()];
    },
    async get(runnerId) {
      gotten.push(runnerId);
      return clients.get(runnerId) ?? null;
    },
    async select() {
      throw new Error('この試験群では使わない（配置は検証対象ではない）');
    },
    async register() {
      /* 使わない */
    },
    async unregister() {
      /* 使わない */
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
      /* 使わない */
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
    gotten,
  };
}

function fakeRunner(
  runnerId: string,
  workspacePath = '/work/project',
  workspacePathKnown = true,
): { client: RunnerClient; resumes: RunnerResumeCommand[] } {
  const resumes: RunnerResumeCommand[] = [];
  const sessions = new Map<string, RunnerManagerState>();
  const client: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown,
    workspacePath,
    async connect() {
      /* 使わない */
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
      /* 使わない */
    },
  };
  return { client, resumes };
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

function setup(stores: ReturnType<typeof createMemoryStores>, registry: RunnerRegistry) {
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({ stores, post: (event) => inbox.push(event), runners: registry });
  return { pool, inbox };
}

const LADDER_MS = 10 * 60_000;

describe('移送の候補が resume を投げずに抜けると、委譲が running のまま誰にも引き取られない（#3103）', () => {
  async function jobOf(stores: ReturnType<typeof createMemoryStores>, id: string) {
    return (await stores.jobs.listJobs()).find((j) => j.id === id);
  }

  it('候補 b が workspace-path-unknown で抜けたあと、梯子を回しても b は二度と試されず、委譲は running のまま残る', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-silent', 'runner-a', { cwd: undefined }));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
      const runnerB = fakeRunner('runner-b', '', false);
      fake.addClient(runnerB.client);
      const { pool } = setup(stores, fake.registry);

      await pool.reattachRunner('runner-b');
      const getsAfterFirst = fake.gotten.length;
      await vi.advanceTimersByTimeAsync(LADDER_MS);

      const job = await jobOf(stores, 'mgr-silent');
      expect({
        resumesOnB: runnerB.resumes.length,
        retriedAfterExit: fake.gotten.length - getsAfterFirst,
      }).toEqual({ resumesOnB: 0, retriedAfterExit: 0 });
      expect({ status: job?.status, runnerId: job?.runnerId }).toEqual({
        status: 'lost',
        runnerId: 'runner-a',
      });
      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('b が 4xx で断り、c が workspace-path-unknown で抜けると、候補が尽きたと数えられず running のまま残る（#3098 との合わせ技）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-silent-c', 'runner-a', { cwd: undefined }));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
      fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
      const runnerB = fakeRunner('runner-b');
      runnerB.client.resume = async () => {
        throw new RunnerHttpError('forbidden (runner-b 固有の設定)', 403);
      };
      const runnerC = fakeRunner('runner-c', '', false);
      fake.addClient(runnerB.client);
      fake.addClient(runnerC.client);
      const { pool } = setup(stores, fake.registry);

      await pool.reattachRunner('runner-b');
      await vi.advanceTimersByTimeAsync(LADDER_MS);

      const job = await jobOf(stores, 'mgr-silent-c');
      expect(runnerC.resumes.length).toBe(0);
      expect(job?.status).toBe('lost');
      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

async function journalTexts(stores: ReturnType<typeof createMemoryStores>): Promise<string[]> {
  return (await stores.journal.list({ limit: 500 })).map((entry) =>
    entry.type === 'decision' ? `${entry.decision}\n${entry.grounds}` : JSON.stringify(entry),
  );
}

describe('移送で引き取れない抜け方をした候補の扱い（#3103 案 A）', () => {
  async function jobOf(stores: ReturnType<typeof createMemoryStores>, id: string) {
    return (await stores.jobs.listJobs()).find((j) => j.id === id);
  }

  it('(a) b が workspace-path-unknown で抜けても、ほかの候補 c が受ければ c へ移る（lost にしない）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-a', 'runner-a', { cwd: undefined }));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
      fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
      const runnerB = fakeRunner('runner-b', '', false);
      const runnerC = fakeRunner('runner-c');
      fake.addClient(runnerB.client);
      fake.addClient(runnerC.client);
      const { pool } = setup(stores, fake.registry);

      await pool.reattachRunner('runner-b');
      expect((await jobOf(stores, 'mgr-a'))?.status).toBe('running');
      await vi.advanceTimersByTimeAsync(LADDER_MS);

      const job = await jobOf(stores, 'mgr-a');
      expect({
        resumesOnB: runnerB.resumes.length,
        resumesOnC: runnerC.resumes.length,
        status: job?.status,
        runnerId: job?.runnerId,
      }).toEqual({ resumesOnB: 0, resumesOnC: 1, status: 'running', runnerId: 'runner-c' });
      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('(b) 移送のときの no-session は候補を回さずその場で lost になり、日誌とクローンへの知らせに理由が入る', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-ns', 'runner-a', { sessionId: undefined }));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
      fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
      const runnerB = fakeRunner('runner-b');
      const runnerC = fakeRunner('runner-c');
      fake.addClient(runnerB.client);
      fake.addClient(runnerC.client);
      const { pool, inbox } = setup(stores, fake.registry);

      await pool.reattachRunner('runner-b');
      await vi.advanceTimersByTimeAsync(LADDER_MS);

      const job = await jobOf(stores, 'mgr-ns');
      expect({
        status: job?.status,
        resumes: runnerB.resumes.length + runnerC.resumes.length,
      }).toEqual({
        status: 'lost',
        resumes: 0,
      });
      const texts = await journalTexts(stores);
      expect(
        texts.some((t) => t.includes('no-session') && t.includes('どの runner でも開き直せない')),
      ).toBe(true);
      const notices = inbox.flatMap((event) =>
        event.type === 'manager_message' ? [event.text] : [],
      );
      expect(notices.some((t) => t.includes('no-session'))).toBe(true);
      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('(c) 移送ではない復帰（宛先が名乗り直した）の no-session と workspace-path-unknown は従来どおり lost にしない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-ns-home', 'runner-a', { sessionId: undefined }));
      await stores.jobs.putJob(jobWith('mgr-wpu-home', 'runner-a', { cwd: undefined }));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
      const runnerA = fakeRunner('runner-a', '', false);
      fake.addClient(runnerA.client);
      const { pool } = setup(stores, fake.registry);

      await pool.reattachRunner('runner-a');
      await vi.advanceTimersByTimeAsync(LADDER_MS);

      expect({
        ns: (await jobOf(stores, 'mgr-ns-home'))?.status,
        wpu: (await jobOf(stores, 'mgr-wpu-home'))?.status,
        resumes: runnerA.resumes.length,
      }).toEqual({ ns: 'running', wpu: 'running', resumes: 0 });
      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('併存を関門より前で検出して見送った候補も断りとして数え、候補が尽きたら lost に確定する', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-dup', 'runner-a'));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('http://b-1', 'connected', 'runner-b'));
      fake.entries.push(entryOf('http://b-2', 'connected', 'runner-b'));
      const runnerB = fakeRunner('runner-b');
      fake.addClient(runnerB.client);
      const { pool } = setup(stores, fake.registry);

      await pool.reattachRunner('runner-b');

      expect({
        status: (await jobOf(stores, 'mgr-dup'))?.status,
        resumes: runnerB.resumes.length,
      }).toEqual({ status: 'lost', resumes: 0 });
      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('併存の見送りが梯子で繰り返し届いても、同じ (委譲, runner) の断りの日誌は1本のまま（#3148）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stores = createMemoryStores();
      await stores.jobs.putJob(jobWith('mgr-dup-ladder', 'runner-a'));
      const fake = createFakeRegistry();
      fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
      fake.entries.push(entryOf('http://b-1', 'connected', 'runner-b'));
      fake.entries.push(entryOf('http://b-2', 'connected', 'runner-b'));
      fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
      const runnerB = fakeRunner('runner-b');
      fake.addClient(runnerB.client);
      const { pool } = setup(stores, fake.registry);

      await pool.reattachRunner('runner-b');
      await vi.advanceTimersByTimeAsync(LADDER_MS);

      const refusals = (await journalTexts(stores)).filter((t) =>
        t.includes('移送先 runner-b が resume を断った'),
      );
      expect(refusals.length).toBe(1);
      expect({
        status: (await jobOf(stores, 'mgr-dup-ladder'))?.status,
        resumes: runnerB.resumes.length,
      }).toEqual({ status: 'running', resumes: 0 });
      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

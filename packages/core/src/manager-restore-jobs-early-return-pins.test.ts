import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerEntry,
  RunnerEvent,
  RunnerLiveness,
  RunnerManagerState,
} from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// `Pool#restoreJobs`（`#restoreJobs`）の早い return / continue のうち、既存の試験が1本も縛っていなかったものを、
// 外から見える結果（`restore()` の戻り値・台帳の行・日誌・runner への命令の記録）だけで縛る。
// 段（非公開メソッド）へ分けるときに早い return / continue を取り違えると落ちる。

const CLOCK = Date.parse('2026-09-01T00:00:00.000Z');

interface Gate {
  entered: Promise<void>;
  opened: Promise<void>;
  markEntered: () => void;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  let markEntered!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  return { entered, opened, markEntered, open };
}

function entryOf(state: RunnerLiveness, runnerId: string): RunnerEntry {
  return {
    label: runnerId,
    state,
    runnerId,
    since: '2026-08-01T00:00:00.000Z',
    revision: { status: 'unheard' },
  };
}

function stateOf(managerId: string, status: RunnerManagerState['status']): RunnerManagerState {
  return {
    liveBackgroundTasks: 0,
    managerId,
    status,
    cwd: '/work/project',
    request: '続きをやって',
    waiting: [],
    sessionId: `sess-${managerId}`,
  };
}

interface Fake {
  client: RunnerClient;
  resumes: string[];
  sends: string[];
  listCalls: () => number;
  sessions: Map<string, RunnerManagerState>;
  /** 指定すると、状態は読めないが居る委譲として答える。 */
  unreadableIds: string[];
  emit: (event: RunnerEvent) => void;
  resumeGates: Map<string, Gate>;
}

function fakeRunner(runnerId: string): Fake {
  const resumes: string[] = [];
  const sends: string[] = [];
  const sessions = new Map<string, RunnerManagerState>();
  let listCalls = 0;
  const holder: { emit?: (event: RunnerEvent) => void } = {};
  const fake: Fake = {
    resumes,
    sends,
    sessions,
    unreadableIds: [],
    resumeGates: new Map(),
    listCalls: () => listCalls,
    emit: (event) => {
      if (holder.emit === undefined) throw new Error('まだ接続されていない');
      holder.emit(event);
    },
    client: {
      runnerId,
      runnerIdKnown: true,
      workspacePathKnown: true,
      workspacePath: '/work/project',
      async connect(onEvent) {
        holder.emit = onEvent;
      },
      async start(command): Promise<{ cwd: string }> {
        return { cwd: command.cwd };
      },
      async resume(command): Promise<{ cwd: string }> {
        resumes.push(command.managerId);
        const resumeGate = fake.resumeGates.get(command.managerId);
        if (resumeGate !== undefined) {
          resumeGate.markEntered();
          await resumeGate.opened;
        }
        sessions.set(command.managerId, stateOf(command.managerId, 'running'));
        return { cwd: command.cwd };
      },
      async send(_managerId, text) {
        sends.push(text);
        return true;
      },
      async answer(): Promise<RunnerAnswerOutcome> {
        return { delivered: false };
      },
      async stop(managerId) {
        sessions.delete(managerId);
      },
      async list() {
        listCalls += 1;
        return [...sessions.values()];
      },
      async listWithUnreadable() {
        listCalls += 1;
        return { states: [...sessions.values()], unreadableIds: [...fake.unreadableIds] };
      },
      async transcript() {
        return null;
      },
      async credentials() {
        return [];
      },
      async setCredentials() {
        return [];
      },
      async profile() {
        return undefined;
      },
      async setProfile() {
        return { ok: true as const };
      },
      async close() {
        /* この検証では使わない。 */
      },
    },
  };
  return fake;
}

interface Env {
  pool: ManagerPool;
  stores: Stores;
}

async function build(options: {
  runners: Fake[];
  entries: RunnerEntry[];
  jobs?: Job[];
  wrapStores?: (stores: Stores) => Stores;
}): Promise<Env> {
  const base = createMemoryStores();
  for (const job of options.jobs ?? []) await base.jobs.putJob(job);
  const stores = options.wrapStores === undefined ? base : options.wrapStores(base);
  const clients = new Map(options.runners.map((fake) => [fake.client.runnerId, fake]));
  const registry = fakeRunnerRegistry({
    async list() {
      return [...clients.values()].map((fake) => fake.client);
    },
    async get(runnerId) {
      return clients.get(runnerId)?.client ?? null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
    async register() {
      /* この検証では使わない。 */
    },
    async unregister() {
      /* この検証では使わない。 */
    },
    vacate() {
      /* この検証では使わない。 */
    },
    entries() {
      return options.entries.map((entry) => ({ ...entry }));
    },
    noteManagerFailed() {
      /* この検証では使わない。 */
    },
    subscribe() {
      return () => {};
    },
    async stop() {},
  });
  const pool = createManagerPool({
    stores,
    post: () => {},
    runners: registry,
    now: () => CLOCK,
  });
  return { pool, stores };
}

function jobOf(id: string, runnerId: string | undefined, overrides: Partial<Job> = {}): Job {
  return {
    id,
    managerId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running',
    summary: '走行中の委譲',
    request: '続きをやって',
    cwd: '/work/project',
    sessionId: `sess-${id}`,
    ...(runnerId === undefined ? {} : { runnerId }),
    ...overrides,
  };
}

async function journalText(stores: Stores): Promise<string> {
  const entries = await stores.journal.list({});
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('restore: 入口と像の有無の早い return', () => {
  it('止めた後の restore は空を返し、runner に聞かず何も起こさない', async () => {
    const a = fakeRunner('runner-a');
    const env = await build({
      runners: [a],
      entries: [entryOf('connected', 'runner-a')],
      jobs: [jobOf('mgr-1', 'runner-a')],
    });
    await env.pool.stop();
    const listsBefore = a.listCalls();

    const restored = await env.pool.restore();

    expect(restored).toEqual([]);
    expect(a.listCalls()).toBe(listsBefore);
    expect(a.resumes).toEqual([]);
  });

  it('像が既に在る委譲は、2回目の restore で引き取り直さない（戻り値に載せない）', async () => {
    const a = fakeRunner('runner-a');
    a.sessions.set('mgr-1', stateOf('mgr-1', 'running'));
    const env = await build({
      runners: [a],
      entries: [entryOf('connected', 'runner-a')],
      jobs: [jobOf('mgr-1', 'runner-a')],
    });

    const first = await env.pool.restore();
    const second = await env.pool.restore();

    expect(first.map((summary) => summary.managerId)).toEqual(['mgr-1']);
    expect(second).toEqual([]);
    await env.pool.stop();
  });
});

describe('restore: 引き取り方を分ける continue', () => {
  it('状態を読めないが runner に居る委譲は、resume せず宛先だけ台帳へ書いて引き取る（戻り値には載せない）', async () => {
    const a = fakeRunner('runner-a');
    a.unreadableIds = ['mgr-1'];
    const env = await build({
      runners: [a],
      entries: [entryOf('connected', 'runner-a')],
      jobs: [jobOf('mgr-1', undefined)],
    });

    const restored = await env.pool.restore();

    expect(restored).toEqual([]);
    expect(a.resumes).toEqual([]);
    expect((await env.stores.jobs.getJob('mgr-1'))?.runnerId).toBe('runner-a');
    await env.pool.stop();
  });

  it('状態を読めない委譲は、台帳の status が done でも像を後から別の行で載せ直さず、書いた宛先のまま見せる', async () => {
    const a = fakeRunner('runner-a');
    a.unreadableIds = ['mgr-1'];
    const env = await build({
      runners: [a],
      entries: [entryOf('connected', 'runner-a')],
      jobs: [jobOf('mgr-1', undefined, { status: 'done' })],
    });

    const restored = await env.pool.restore();

    expect(restored).toEqual([]);
    expect(a.resumes).toEqual([]);
    const listed = (await env.pool.list()).find((summary) => summary.managerId === 'mgr-1');
    expect(listed?.runnerId).toBe('runner-a');
    await env.pool.stop();
  });

  it('runner に生きて居る委譲は、台帳の status が done でも runner の答えの status で像を載せ、resume しない', async () => {
    const a = fakeRunner('runner-a');
    a.sessions.set('mgr-1', stateOf('mgr-1', 'running'));
    const env = await build({
      runners: [a],
      entries: [entryOf('connected', 'runner-a')],
      jobs: [jobOf('mgr-1', 'runner-a', { status: 'done' })],
    });

    const restored = await env.pool.restore();

    expect(restored.map((summary) => [summary.managerId, summary.status])).toEqual([
      ['mgr-1', 'running'],
    ]);
    expect(a.resumes).toEqual([]);
    const listed = (await env.pool.list()).find((summary) => summary.managerId === 'mgr-1');
    expect(listed?.status).toBe('running');
    await env.pool.stop();
  });
});

describe('restore: 居ない委譲を resume する前の continue', () => {
  it('session_id が無い委譲は、像を載せず resume もしない', async () => {
    const a = fakeRunner('runner-a');
    const env = await build({
      runners: [a],
      entries: [entryOf('connected', 'runner-a')],
      jobs: [jobOf('mgr-1', 'runner-a', { sessionId: undefined })],
    });

    const restored = await env.pool.restore();

    expect(restored).toEqual([]);
    expect(a.resumes).toEqual([]);
    await env.pool.stop();
  });

  it('読み直した行が lost だった委譲は、像を載せず resume もしない', async () => {
    const a = fakeRunner('runner-a');
    const env = await build({
      runners: [a],
      entries: [entryOf('connected', 'runner-a')],
      jobs: [jobOf('mgr-1', 'runner-a')],
      wrapStores: (stores) => ({
        ...stores,
        jobs: {
          ...stores.jobs,
          getJob: async (id) => {
            const row = await stores.jobs.getJob(id);
            return row === undefined || row === null ? row : { ...row, status: 'lost' as const };
          },
        },
      }),
    });

    const restored = await env.pool.restore();

    expect(restored).toEqual([]);
    expect(a.resumes).toEqual([]);
    // 像を載せていれば lost の行が一覧へ出る。載せていないので、一覧は台帳の行（running）のまま。
    const listed = (await env.pool.list()).find((summary) => summary.managerId === 'mgr-1');
    expect(listed?.status).toBe('running');
    await env.pool.stop();
  });

  it('読み直す間に別の契機が像を載せた委譲は、resume しない', async () => {
    const a = fakeRunner('runner-a');
    const readGate = gate();
    let armed = true;
    const env = await build({
      runners: [a],
      entries: [entryOf('connected', 'runner-a')],
      jobs: [jobOf('mgr-1', 'runner-a')],
      wrapStores: (stores) => ({
        ...stores,
        jobs: {
          ...stores.jobs,
          getJob: async (id) => {
            const row = await stores.jobs.getJob(id);
            if (armed && id === 'mgr-1') {
              armed = false;
              readGate.markEntered();
              await readGate.opened;
            }
            return row;
          },
        },
      }),
    });

    const restoring = env.pool.restore();
    await readGate.entered;
    // 台帳を読み直している間に、runner の出来事が届いて像が載る。
    a.emit({
      type: 'mirror',
      managerId: 'mgr-1',
      key: { projectKey: 'p', sessionId: 'sess-mgr-1' },
      entries: [],
    });
    await Promise.resolve();
    await vi.waitFor(async () => {
      const s = await env.pool.get?.('mgr-1');
      if (s === undefined) throw new Error('まだ');
    });
    readGate.open();
    const restored = await restoring;

    expect(restored).toEqual([]);
    expect(a.resumes).toEqual([]);
    await env.pool.stop();
  });
});

describe('restore: resume が受理された後の continue', () => {
  it('受理されても、その間に lost へ確定していた委譲は running へ戻さず、戻り値にも載せず、再開の日誌も書かない', async () => {
    const a = fakeRunner('runner-a');
    const resumeGate = gate();
    a.resumeGates.set('mgr-1', resumeGate);
    const env = await build({
      runners: [a],
      entries: [entryOf('connected', 'runner-a')],
      jobs: [jobOf('mgr-1', 'runner-a')],
    });

    const restoring = env.pool.restore();
    await resumeGate.entered;
    a.emit({
      type: 'resume_failed',
      managerId: 'mgr-1',
      sessionId: 'sess-mgr-1',
      reason: '会話が見つからなかった',
      recovered: false,
    });
    await vi.waitFor(async () => {
      if ((await env.stores.jobs.getJob('mgr-1'))?.status !== 'lost') {
        throw new Error('lost への確定がまだ書かれていない');
      }
    });
    resumeGate.open();
    const restored = await restoring;

    expect(restored).toEqual([]);
    expect((await env.stores.jobs.getJob('mgr-1'))?.status).toBe('lost');
    expect(await journalText(env.stores)).not.toContain('再起動後の再開');
    await env.pool.stop();
  });
});

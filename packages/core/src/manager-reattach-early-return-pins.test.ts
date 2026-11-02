import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerEntry,
  RunnerEvent,
  RunnerLiveness,
  RunnerManagerState,
  RunnerRegistry,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// `Pool#reattach`（`#reattach`）の早い return / continue のうち、既存の試験が1本も縛っていなかったものを、
// 外から見える結果（台帳の行・日誌・runner への命令の記録・名簿への問い合わせの回数）だけで縛る。
// 段（非公開メソッド）へ分けるときに早い return を取り違えると落ちる。
//   - 止めた後の呼びは何もしない（入口・復元待ちの後）
//   - 重なった名乗りは、本体を重ねず、終わった後に1回だけ取り直す
//   - 名簿に居ない runner は挑み直さない
//   - 台帳が読めなかった回は、runner に聞かずに予約する。読んだ後に止められたら何もしない
//   - runner の一覧を読む間に止められたら、居る委譲の宛先も書き換えない
//   - ループの中: 止められた後は残りの委譲を起こさない・読み直した宛先が変わった委譲は起こさない
//   - 受理された resume の後に lost へ確定していた委譲は、running へ戻さない

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

interface Fake {
  client: RunnerClient;
  resumes: string[];
  listCalls: () => number;
  sessions: Map<string, RunnerManagerState>;
  emit: (event: RunnerEvent) => void;
  /** 指定すると、その managerId の `resume` はこの門が開くまで返らない。 */
  resumeGates: Map<string, Gate>;
  /** 指定すると、最初の `list` 1回だけこの門が開くまで返らない。 */
  listGate?: Gate;
  sends: string[];
}

function fakeRunner(runnerId: string): Fake {
  const resumes: string[] = [];
  const sends: string[] = [];
  const sessions = new Map<string, RunnerManagerState>();
  let listCalls = 0;
  const holder: { emit?: (event: RunnerEvent) => void } = {};
  const fake: Fake = {
    resumes,
    sessions,
    sends,
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
        sessions.set(command.managerId, {
          liveBackgroundTasks: 0,
          managerId: command.managerId,
          status: 'running',
          cwd: command.cwd,
          request: command.request,
          waiting: [],
          sessionId: command.sessionId,
        });
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
        const listGate = fake.listGate;
        if (listGate !== undefined) {
          fake.listGate = undefined;
          listGate.markEntered();
          await listGate.opened;
        }
        return [...sessions.values()];
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
  runners: Map<string, Fake>;
  entries: RunnerEntry[];
  /** `registry.get` を引かれた回数（runnerId ごと）。 */
  getCalls: (runnerId: string) => number;
}

function build(options: {
  runners: Fake[];
  entries: RunnerEntry[];
  jobs?: Job[];
  /** 台帳の差し替え（`createMemoryStores()` の結果を包む）。 */
  wrapStores?: (stores: Stores) => Stores;
}): Promise<Env> {
  return (async () => {
    const base = createMemoryStores();
    for (const job of options.jobs ?? []) await base.jobs.putJob(job);
    const stores = options.wrapStores === undefined ? base : options.wrapStores(base);
    const clients = new Map(options.runners.map((fake) => [fake.client.runnerId, fake]));
    const gets = new Map<string, number>();
    const registry: RunnerRegistry = {
      async list() {
        return [...clients.values()].map((fake) => fake.client);
      },
      async get(runnerId) {
        gets.set(runnerId, (gets.get(runnerId) ?? 0) + 1);
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
    };
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: registry,
      now: () => CLOCK,
    });
    return {
      pool,
      stores,
      runners: clients,
      entries: options.entries,
      getCalls: (runnerId) => gets.get(runnerId) ?? 0,
    };
  })();
}

function jobOf(id: string, runnerId: string, overrides: Partial<Job> = {}): Job {
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
    runnerId,
    ...overrides,
  };
}

async function journalText(stores: Stores): Promise<string> {
  const entries = await stores.journal.list({});
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

async function runnerIdOf(stores: Stores, id: string): Promise<string | undefined> {
  return (await stores.jobs.getJob(id))?.runnerId;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reattach: 入口の早い return', () => {
  it('止めた後の呼びは、名簿へ問い合わせず何も起こさない', async () => {
    const a = fakeRunner('runner-a');
    const env = await build({
      runners: [a],
      entries: [entryOf('connected', 'runner-a')],
      jobs: [jobOf('mgr-1', 'runner-a')],
    });
    await env.pool.stop();
    const getsBefore = env.getCalls('runner-a');
    const listsBefore = a.listCalls();

    await env.pool.reattachRunner('runner-a');

    expect(env.getCalls('runner-a')).toBe(getsBefore);
    expect(a.listCalls()).toBe(listsBefore);
    expect(a.resumes).toEqual([]);
    expect((await env.stores.jobs.getJob('mgr-1'))?.status).toBe('running');
  });

  it('処理中に重なった名乗りは本体を重ねず返り、終わった後に1回だけ取り直す', async () => {
    const a = fakeRunner('runner-a');
    const env = await build({ runners: [a], entries: [entryOf('connected', 'runner-a')] });
    const listGate = gate();
    a.listGate = listGate;

    const first = env.pool.reattachRunner('runner-a');
    await listGate.entered;
    expect(env.getCalls('runner-a')).toBe(1);

    await env.pool.reattachRunner('runner-a');
    // 重ねた本体が走っていれば、ここで名簿への2回目の問い合わせが起きている。
    expect(env.getCalls('runner-a')).toBe(1);
    expect(a.listCalls()).toBe(1);

    listGate.open();
    await first;
    // 重なった名乗りは捨てず、終わった後に即時で1回取り直す。
    await vi.waitFor(() => {
      if (a.listCalls() < 2) throw new Error('取り直しがまだ走っていない');
    });
    expect(env.getCalls('runner-a')).toBe(2);
    expect(a.listCalls()).toBe(2);
    await env.pool.stop();
  });

  it('復元の完了を待つ間に止められたら、その後の取り直しは名簿へ問い合わせない', async () => {
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
    const reattaching = env.pool.reattachRunner('runner-a');
    await Promise.resolve();
    const stopping = env.pool.stop();
    const getsBefore = env.getCalls('runner-a');
    const listsBefore = a.listCalls();

    resumeGate.open();
    await restoring;
    await reattaching;
    await stopping;

    expect(env.getCalls('runner-a')).toBe(getsBefore);
    expect(a.listCalls()).toBe(listsBefore);
  });

  it('名簿に居ない runner は、挑み直しを予約しない', async () => {
    vi.useFakeTimers();
    const a = fakeRunner('runner-a');
    const env = await build({ runners: [a], entries: [entryOf('connected', 'runner-a')] });

    await env.pool.reattachRunner('runner-ghost');
    expect(env.getCalls('runner-ghost')).toBe(1);

    // 梯子の間隔の上限（30 秒）を十分に越えて進めても、2回目は来ない。
    await vi.advanceTimersByTimeAsync(120_000);
    expect(env.getCalls('runner-ghost')).toBe(1);
    await env.pool.stop();
  });
});

describe('reattach: 台帳と runner の一覧を読む前後の早い return', () => {
  it('台帳を読めなかった回は、runner に聞かずに日誌へ残して予約し、次の回で進む', async () => {
    vi.useFakeTimers();
    const a = fakeRunner('runner-a');
    let armed = true;
    const env = await build({
      runners: [a],
      entries: [entryOf('connected', 'runner-a')],
      jobs: [jobOf('mgr-1', 'runner-a')],
      wrapStores: (stores) => ({
        ...stores,
        jobs: {
          ...stores.jobs,
          listJobs: async () => {
            if (armed) {
              armed = false;
              throw new Error('台帳の一時障害');
            }
            return stores.jobs.listJobs();
          },
        },
      }),
    });

    await env.pool.reattachRunner('runner-a');

    expect(a.listCalls()).toBe(0);
    expect(a.resumes).toEqual([]);
    const text = await journalText(env.stores);
    expect(text).toContain(
      '台帳の委譲の一覧を読めなかったので、runnerId=runner-a の取り直しを進めなかった（居ない委譲を起こすことも、居る委譲を死んだと読むこともしていない。予約して挑み直す）',
    );

    // 予約した梯子の1回目（1 秒後）で、今度は読めて先へ進む。
    await vi.advanceTimersByTimeAsync(1_000);
    expect(a.listCalls()).toBe(1);
    await env.pool.stop();
  });

  it('台帳を読む間に止められたら、runner に聞かずに戻る', async () => {
    const a = fakeRunner('runner-a');
    const listGate = gate();
    let armed = true;
    const env = await build({
      runners: [a],
      entries: [entryOf('connected', 'runner-a')],
      jobs: [jobOf('mgr-1', 'runner-a')],
      wrapStores: (stores) => ({
        ...stores,
        jobs: {
          ...stores.jobs,
          listJobs: async () => {
            const rows = await stores.jobs.listJobs();
            if (armed) {
              armed = false;
              listGate.markEntered();
              await listGate.opened;
            }
            return rows;
          },
        },
      }),
    });

    const reattaching = env.pool.reattachRunner('runner-a');
    await listGate.entered;
    const stopping = env.pool.stop();
    listGate.open();
    await reattaching;
    await stopping;

    expect(a.listCalls()).toBe(0);
    expect(a.resumes).toEqual([]);
  });

  it('runner の一覧を読む間に止められたら、居る委譲の宛先を台帳で書き換えない', async () => {
    const a = fakeRunner('runner-a');
    const b = fakeRunner('runner-b');
    a.sessions.set('mgr-1', {
      liveBackgroundTasks: 0,
      managerId: 'mgr-1',
      status: 'running',
      cwd: '/work/project',
      request: '続きをやって',
      waiting: [],
      sessionId: 'sess-mgr-1',
    });
    const env = await build({
      runners: [a, b],
      entries: [entryOf('connected', 'runner-a'), entryOf('lost', 'runner-b')],
      jobs: [jobOf('mgr-1', 'runner-b')],
    });
    const listGate = gate();
    a.listGate = listGate;

    const reattaching = env.pool.reattachRunner('runner-a');
    await listGate.entered;
    const stopping = env.pool.stop();
    listGate.open();
    await reattaching;
    await stopping;

    expect(await runnerIdOf(env.stores, 'mgr-1')).toBe('runner-b');
    expect(a.resumes).toEqual([]);
  });
});

describe('reattach: ループの中の continue', () => {
  it('先の委譲を resume している最中に止められたら、後ろの委譲は起こさない', async () => {
    const a = fakeRunner('runner-a');
    const resumeGate = gate();
    a.resumeGates.set('mgr-first', resumeGate);
    const env = await build({
      runners: [a],
      entries: [entryOf('connected', 'runner-a')],
      jobs: [jobOf('mgr-first', 'runner-a'), jobOf('mgr-second', 'runner-a')],
    });

    const reattaching = env.pool.reattachRunner('runner-a');
    await resumeGate.entered;
    const stopping = env.pool.stop();
    resumeGate.open();
    await reattaching;
    await stopping;

    expect(a.resumes).toEqual(['mgr-first']);
  });

  it('読み直した宛先が変わっていた委譲は、この runner では起こさない', async () => {
    const a = fakeRunner('runner-a');
    const b = fakeRunner('runner-b');
    const c = fakeRunner('runner-c');
    const resumeGate = gate();
    a.resumeGates.set('mgr-first', resumeGate);
    const env = await build({
      runners: [a, b, c],
      entries: [
        entryOf('connected', 'runner-a'),
        entryOf('lost', 'runner-b'),
        entryOf('connected', 'runner-c'),
      ],
      jobs: [jobOf('mgr-first', 'runner-a'), jobOf('mgr-moved', 'runner-b')],
    });

    const reattaching = env.pool.reattachRunner('runner-a');
    await resumeGate.entered;
    // 待っている間に、別の取り直しが mgr-moved を runner-c へ移し終えた（台帳の宛先が変わった）。
    await env.stores.jobs.putJob(jobOf('mgr-moved', 'runner-c'));
    resumeGate.open();
    await reattaching;

    expect(a.resumes).toEqual(['mgr-first']);
    expect(await runnerIdOf(env.stores, 'mgr-moved')).toBe('runner-c');
    await env.pool.stop();
  });

  it('resume が受理されても、その間に lost へ確定していた委譲は running へ戻さず、再開の知らせも出さない', async () => {
    const a = fakeRunner('runner-a');
    const resumeGate = gate();
    a.resumeGates.set('mgr-1', resumeGate);
    const env = await build({ runners: [a], entries: [entryOf('connected', 'runner-a')] });
    // 委譲の無い起動時の引き取りで runner へ接続しておく（出来事を流す口が開く）。
    await env.pool.restore();
    await env.stores.jobs.putJob(jobOf('mgr-1', 'runner-a'));

    const reattaching = env.pool.reattachRunner('runner-a');
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
    await reattaching;

    expect((await env.stores.jobs.getJob('mgr-1'))?.status).toBe('lost');
    expect(await journalText(env.stores)).not.toContain('runner 入れ替え後の再開');
    expect(a.sends).toEqual([]);
    await env.pool.stop();
  });
});

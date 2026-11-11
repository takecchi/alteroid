import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import { FakeRunnerClientBase, fakeRunnerClient } from './runner-client.test-support.js';
import { RunnerHttpError, createRunnerRegistry } from './runner-protocol.js';
import type {
  RunnerClient,
  RunnerEntry,
  RunnerLiveness,
  RunnerManagerState,
  RunnerRegistry,
  RunnerResumeCommand,
} from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// 仕様を先に書いたものではなく、今の出力から変えないための歯（`ManagerReattach` へ切り出す前後で動きを変えないための縛り）。
// 既存の試験が縛っていなかった 6 点を、外から見える結果だけで縛る:
//   - busy の取り直しの上限（回数ちょうどで止まる）
//   - 梯子の予約の timer は `unref` される
//   - `reattach` の完了までの `await` の周回数（finally の予約の呼びは `await` しない）
//   - 併存を検出した回の梯子は間隔を上限（30 秒）に固定する
//   - 起動時の引き取り（`restore()`）が走っている間、名乗りの取り直しは待つ
//   - 移送先の 4xx で貸し出しを返す時刻は Pool の時計
// 実時間は使わない（fake timer と `setImmediate` / `await Promise.resolve()` の有界の回数）。

function entryOf(label: string, state: RunnerLiveness, runnerId?: string): RunnerEntry {
  return {
    label,
    state,
    ...(runnerId === undefined ? {} : { runnerId }),
    since: '2026-08-01T00:00:00.000Z',
    revision: { status: 'unheard' },
  };
}

function jobWith(id: string, runnerId: string, overrides: Partial<Job> = {}): Job {
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

function createFakeRegistry(): {
  registry: RunnerRegistry;
  entries: RunnerEntry[];
  addClient: (client: RunnerClient) => void;
} {
  const clients = new Map<string, RunnerClient>();
  const entries: RunnerEntry[] = [];
  const registry = fakeRunnerRegistry({
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
  });
  return { registry, entries, addClient: (client) => clients.set(client.runnerId, client) };
}

function fakeRunner(runnerId: string): {
  client: RunnerClient;
  resumes: RunnerResumeCommand[];
  sessions: Map<string, RunnerManagerState>;
} {
  const resumes: RunnerResumeCommand[] = [];
  const sessions = new Map<string, RunnerManagerState>();
  const client = fakeRunnerClient({
    runnerId,
    async resume(command): Promise<{ cwd: string }> {
      resumes.push(command);
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
    async stop(managerId) {
      sessions.delete(managerId);
    },
    async list() {
      return [...sessions.values()];
    },
  });
  return { client, resumes, sessions };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reattach の busy の取り直しの上限', () => {
  it('別の契機の resume が終わらない間、取り直しは上限ちょうどの回数で止まる（初回 + 5 回の予約 = list 6 回）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-busy', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    let entered!: () => void;
    const enteredResume = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resumes = 0;
    const originalResume = runnerA.client.resume.bind(runnerA.client);
    runnerA.client.resume = async (command) => {
      resumes += 1;
      if (resumes === 1) {
        entered();
        await new Promise<void>(() => {});
      }
      return originalResume(command);
    };
    let lists = 0;
    const originalList = runnerA.client.list.bind(runnerA.client);
    runnerA.client.list = async () => {
      lists += 1;
      return originalList();
    };
    fake.addClient(runnerA.client);
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
    void pool.send('mgr-busy', '続きを').catch(() => undefined);
    await enteredResume;
    await pool.reattachRunner('runner-a');
    for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(31_000);
    await flush();
    expect({ resumes, lists, timers: vi.getTimerCount() }).toMatchInlineSnapshot(`
      {
        "lists": 6,
        "resumes": 1,
        "timers": 0,
      }
    `);
    await pool.stop();
  });
});

describe('reattach の予約の timer', () => {
  it('梯子の予約の timer は unref される（デーモンの終了を引き留めない）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-1', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    runnerA.client.list = async () => {
      throw new RunnerHttpError('runner GET /managers が失敗した (503)', 503);
    };
    fake.addClient(runnerA.client);
    const fakeSetTimeout = globalThis.setTimeout;
    const created: number[] = [];
    const unrefed: number[] = [];
    vi.stubGlobal('setTimeout', ((handler: () => void, ms?: number, ...args: unknown[]) => {
      const timer = (fakeSetTimeout as (...a: unknown[]) => { unref?: () => unknown })(
        handler,
        ms,
        ...args,
      );
      created.push(ms ?? 0);
      const original = timer.unref?.bind(timer);
      if (original !== undefined) {
        timer.unref = () => {
          unrefed.push(ms ?? 0);
          return original();
        };
      }
      return timer;
    }) as unknown as typeof setTimeout);
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });
    await pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(10_000);
    expect({ created: created.slice(0, 4), unrefed: unrefed.slice(0, 4) }).toMatchInlineSnapshot(`
      {
        "created": [
          1000,
          2000,
          4000,
          8000,
        ],
        "unrefed": [
          1000,
          2000,
          4000,
          8000,
        ],
      }
    `);
    await pool.stop();
  });
});

describe('reattach の完了までの await の周回数', () => {
  it('一時的に失敗して予約を積む回も、reattach の完了は予約の呼びを待たない（周回数を固定）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-1', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    runnerA.client.list = async () => {
      throw new RunnerHttpError('runner GET /managers が失敗した (503)', 503);
    };
    fake.addClient(runnerA.client);
    const pool: ManagerPool = createManagerPool({
      stores,
      post: () => {},
      runners: fake.registry,
    });
    let done = false;
    const running = pool.reattachRunner('runner-a').then(() => {
      done = true;
    });
    let ticks = 0;
    while (!done && ticks < 500) {
      ticks += 1;
      await Promise.resolve();
    }
    expect({ done, ticks }).toMatchInlineSnapshot(`
      {
        "done": true,
        "ticks": 20,
      }
    `);
    await running;
    await pool.stop();
  });
});

describe('起動時の引き取りとの直列化', () => {
  it('restore() が走っている間、名乗りの取り直しは runner に list を撃たず、終わってから進む', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-1', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'connected', 'runner-a'));
    const runnerA = fakeRunner('runner-a');
    let lists = 0;
    let gateOpen!: () => void;
    const gate = new Promise<void>((resolve) => {
      gateOpen = resolve;
    });
    const originalList = runnerA.client.list.bind(runnerA.client);
    runnerA.client.list = async () => {
      lists += 1;
      if (lists === 1) await gate;
      return originalList();
    };
    fake.addClient(runnerA.client);
    const pool = createManagerPool({ stores, post: () => {}, runners: fake.registry });

    const restoring = pool.restore();
    await flush();
    const listsInRestore = lists;
    const reattaching = pool.reattachRunner('runner-a');
    await flush();
    const listsWhileRestoring = lists;
    gateOpen();
    await restoring;
    await reattaching;
    expect({
      listsInRestore,
      listsWhileRestoring,
      listsAfter: lists,
    }).toMatchInlineSnapshot(`
      {
        "listsAfter": 2,
        "listsInRestore": 1,
        "listsWhileRestoring": 1,
      }
    `);
    await pool.stop();
  });
});

describe('移送先の 4xx で貸し出しを返す時刻', () => {
  it('貸し出しを返した時刻は Pool の時計の今（注入した now）になる', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const NOW = Date.parse('2026-09-01T00:00:00.000Z');
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-4xx', 'runner-a'));
    const fake = createFakeRegistry();
    fake.entries.push(entryOf('runner-a', 'lost', 'runner-a'));
    fake.entries.push(entryOf('runner-b', 'connected', 'runner-b'));
    fake.entries.push(entryOf('runner-c', 'connected', 'runner-c'));
    const runnerB = fakeRunner('runner-b');
    runnerB.client.resume = async () => {
      throw new RunnerHttpError('forbidden (runner-b 固有の設定)', 403);
    };
    fake.addClient(runnerB.client);
    fake.addClient(fakeRunner('runner-c').client);
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: fake.registry,
      now: () => NOW,
    });

    await pool.reattachRunner('runner-b');

    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-4xx');
    expect({
      status: job?.status,
      leaseRunner: job?.lease?.runnerId,
      releasedAt: job?.lease?.releasedAt,
    }).toMatchInlineSnapshot(`
      {
        "leaseRunner": "runner-b",
        "releasedAt": "2026-09-01T00:00:00.000Z",
        "status": "running",
      }
    `);
    await pool.stop();
  });
});

class DupRunner extends FakeRunnerClientBase {
  readonly runnerId: string;
  readonly sessions = new Map<string, RunnerManagerState>();
  instanceId: string | undefined = 'boot-2';

  constructor(runnerId = 'runner-primary') {
    super();
    this.runnerId = runnerId;
  }

  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    return {
      runnerId: this.runnerId,
      ...(this.instanceId === undefined ? {} : { instanceId: this.instanceId }),
    };
  }
  async connect(): Promise<void> {}
  async list(): Promise<RunnerManagerState[]> {
    return [...this.sessions.values()];
  }
}

describe('併存を検出した回の梯子の間隔', () => {
  it('併存が続く間の予約は 30 秒間隔（上限）に固定され、1 秒からの倍々にならない', async () => {
    vi.useFakeTimers();
    const runner = new DupRunner();
    const registry = createRunnerRegistry();
    await registry.register({ label: 'http://runner:4518', open: async () => runner });
    const duplicate = new DupRunner();
    await registry.register({ label: 'http://runner-dup:4518', open: async () => duplicate });
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobWith('mgr-1', 'runner-primary'));
    const startedAt = Date.now();
    const getTimes: number[] = [];
    const originalGet = registry.get.bind(registry);
    registry.get = async (runnerId) => {
      getTimes.push(Date.now() - startedAt);
      return originalGet(runnerId);
    };
    const pool = createManagerPool({ stores, post: () => {}, runners: registry });
    await pool.reattachRunner('runner-primary');
    await vi.advanceTimersByTimeAsync(130_000);
    expect(getTimes).toMatchInlineSnapshot(`
      [
        0,
        30000,
        60000,
        90000,
        120000,
      ]
    `);
    await pool.stop();
    await registry.stop();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LEASE_DRAIN_MS, LEASE_MARGIN_MS } from './lease.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import { RunnerHttpError } from './runner-protocol.js';
import type { RunnerClient, RunnerEntry, RunnerManagerState } from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 仕様を先に書いたものではなく、今の出力から変えないための歯。
// `Pool#reattach` の梯子（`#reattach` の finally・`#scheduleReattach`・`#classifyReattachError`・`#reattachOne` の結果の写像・
// `stop()` の予約の片付け）のうち、既存の試験が縛っていない枝を、外から見える結果だけで縛る。
// 期待は今の出力を `-u` でインライン snapshot に生成して目で読んだもの。
//   - 梯子の間隔（1 秒から倍々・30 秒で頭打ち）と、成功したら基準へ戻ること
//   - 同じ runner の予約の重複排除・`stop()` での予約の片付け
//   - 処理中に届いた名乗りは、取り直しが一時的に失敗しても予約より即時を優先する
//   - `await` の周回数（予約・再実行までに挟む `await Promise.resolve()` の数）
//   - resume の失敗の仕分け（一時的 → 予約・世代で拒まれた → 止める・それ以外 → lost）
//   - `#reattachOne` の結果から挑み直しの要否への写像（`unreadable`・`held-by-lease`）
// 実時間は使わない（fake timer と `await Promise.resolve()` の有界の回数）。

const CLOCK = Date.parse('2026-09-01T00:00:00.000Z');

function entryOf(runnerId: string, overrides: Partial<RunnerEntry> = {}): RunnerEntry {
  return {
    label: runnerId,
    state: 'connected',
    runnerId,
    since: '2026-08-01T00:00:00.000Z',
    revision: { status: 'unheard' },
    ...overrides,
  };
}

function jobOf(id: string, overrides: Partial<Job> = {}): Job {
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
    runnerId: 'runner-a',
    ...overrides,
  };
}

/** `list` / `resume` を呼ばれた回（1 始まり）で失敗させられる偽の runner。時刻は fake timer の `Date.now()`。 */
interface Fake {
  client: RunnerClient;
  /** 開始時刻からの経過ミリ秒。 */
  listTimes: number[];
  resumeTimes: number[];
  sessions: Map<string, RunnerManagerState>;
  /** 返した値を投げる（`undefined` なら通す）。 */
  listFailure?: (call: number) => unknown;
  resumeFailure?: (call: number) => unknown;
  /** 指定すると、最初の `list` 1回だけこの門が開くまで返らない（開いた後に `listFailure` を適用する）。 */
  listGate?: { entered: () => void; opened: Promise<void> };
}

function fakeRunner(runnerId: string, startedAt: () => number): Fake {
  const fake: Fake = {
    listTimes: [],
    resumeTimes: [],
    sessions: new Map(),
    client: undefined as unknown as RunnerClient,
  };
  fake.client = fakeRunnerClient({
    runnerId,
    async resume(command) {
      fake.resumeTimes.push(Date.now() - startedAt());
      const failure = fake.resumeFailure?.(fake.resumeTimes.length);
      if (failure !== undefined) throw failure;
      fake.sessions.set(command.managerId, {
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
    async list() {
      fake.listTimes.push(Date.now() - startedAt());
      const gate = fake.listGate;
      if (gate !== undefined) {
        fake.listGate = undefined;
        gate.entered();
        await gate.opened;
      }
      const failure = fake.listFailure?.(fake.listTimes.length);
      if (failure !== undefined) throw failure;
      return [...fake.sessions.values()];
    },
  });
  return fake;
}

interface Env {
  pool: ManagerPool;
  stores: Stores;
  fake: Fake;
  inbox: InboxEvent[];
  entries: RunnerEntry[];
}

async function build(
  options: {
    jobs?: Job[];
    entries?: RunnerEntry[];
    wrapStores?: (stores: Stores) => Stores;
  } = {},
): Promise<Env> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(CLOCK);
  const startedAt = CLOCK;
  const fake = fakeRunner('runner-a', () => startedAt);
  const base = createMemoryStores();
  for (const job of options.jobs ?? [jobOf('mgr-1')]) await base.jobs.putJob(job);
  const stores = options.wrapStores === undefined ? base : options.wrapStores(base);
  const entries = options.entries ?? [entryOf('runner-a')];
  const registry = fakeRunnerRegistry({
    async list() {
      return [fake.client];
    },
    async get(runnerId) {
      return runnerId === 'runner-a' ? fake.client : null;
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
      return entries.map((entry) => ({ ...entry }));
    },
    noteManagerFailed() {
      /* この検証では使わない。 */
    },
    subscribe() {
      return () => {};
    },
    async stop() {},
  });
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    now: () => Date.now(),
  });
  return { pool, stores, fake, inbox, entries };
}

/** 有界の回数だけ `await Promise.resolve()` を回し、条件が初めて真になった回（0 始まり）を返す。 */
async function ticksUntil(condition: () => boolean, bound = 200): Promise<number> {
  for (let tick = 0; tick < bound; tick += 1) {
    if (condition()) return tick;
    await Promise.resolve();
  }
  throw new Error(`条件が ${bound} 回の await では満たされなかった`);
}

async function journalDecisions(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['decision'] });
  return entries.map((entry) => (entry.type === 'decision' ? entry.decision : ''));
}

function noticeTexts(inbox: readonly InboxEvent[]): string[] {
  return inbox.flatMap((event) => (event.type === 'manager_message' ? [event.text] : []));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reattach の梯子: 間隔', () => {
  it('一時的な失敗が続く間、予約の間隔は 1 秒から倍々に延び、30 秒で頭打ちになる', async () => {
    const env = await build();
    env.fake.listFailure = () => new RunnerHttpError('runner GET /managers が失敗した (503)', 503);

    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(200_000);

    const gaps = env.fake.listTimes
      .slice(1)
      .map((at, index) => at - (env.fake.listTimes[index] ?? 0));
    expect({ attempts: env.fake.listTimes.length, firstAt: env.fake.listTimes[0], gaps })
      .toMatchInlineSnapshot(`
      {
        "attempts": 11,
        "firstAt": 0,
        "gaps": [
          1000,
          2000,
          4000,
          8000,
          16000,
          30000,
          30000,
          30000,
          30000,
          30000,
        ],
      }
    `);
    await env.pool.stop();
  });

  it('resume が一時的に失敗し続ける場合も、同じ間隔で挑み直す', async () => {
    const env = await build();
    env.fake.resumeFailure = () => new RunnerHttpError('runner POST resume が失敗した (503)', 503);

    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(130_000);

    const gaps = env.fake.resumeTimes
      .slice(1)
      .map((at, index) => at - (env.fake.resumeTimes[index] ?? 0));
    expect({ attempts: env.fake.resumeTimes.length, gaps }).toMatchInlineSnapshot(`
      {
        "attempts": 9,
        "gaps": [
          1000,
          2000,
          4000,
          8000,
          16000,
          30000,
          30000,
          30000,
        ],
      }
    `);
    await env.pool.stop();
  });

  it('梯子の途中で取り直しが通ると間隔は基準へ戻り、次に失敗した回は 1 秒から始まる', async () => {
    const env = await build();
    // 1〜3 回目の list は失敗、4 回目は通る（resume まで進む）、5 回目からはまた失敗する。
    env.fake.listFailure = (call) =>
      call <= 3 || call >= 5
        ? new RunnerHttpError('runner GET /managers が失敗した (503)', 503)
        : undefined;

    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(7_000);
    const afterRecovery = {
      listTimes: [...env.fake.listTimes],
      resumeTimes: [...env.fake.resumeTimes],
    };

    // 通った後は予約が無い。ここで runner が入れ替わり（名乗り直し）、また一時的に失敗する。
    await vi.advanceTimersByTimeAsync(60_000);
    const quiet = env.fake.listTimes.length;
    env.fake.sessions.clear();
    const secondStart = env.fake.listTimes.length;
    await env.pool.reattachRunner('runner-a');
    const base = Date.now() - CLOCK;
    await vi.advanceTimersByTimeAsync(40_000);
    const gaps = env.fake.listTimes
      .slice(secondStart)
      .map((at, index, all) => at - (index === 0 ? base : (all[index - 1] ?? 0)));

    expect({ afterRecovery, quietListCalls: quiet, gapsAfterSecondFailure: gaps })
      .toMatchInlineSnapshot(`
      {
        "afterRecovery": {
          "listTimes": [
            0,
            1000,
            3000,
            7000,
          ],
          "resumeTimes": [
            7000,
          ],
        },
        "gapsAfterSecondFailure": [
          0,
          1000,
          2000,
          4000,
          8000,
          16000,
        ],
        "quietListCalls": 4,
      }
    `);
    await env.pool.stop();
  });
});

describe('reattach の梯子: 予約の重複排除と stop()', () => {
  it('予約が残っている runner への2回目の予約は新しい timer を作らず、間隔も倍にしない', async () => {
    const env = await build();
    env.fake.listFailure = () => new RunnerHttpError('runner GET /managers が失敗した (503)', 503);
    const baseline = vi.getTimerCount();

    await env.pool.reattachRunner('runner-a');
    const afterFirst = vi.getTimerCount() - baseline;
    // 予約が残っている間に、別の契機で名乗りが届いてまた一時的に失敗する。
    await env.pool.reattachRunner('runner-a');
    const afterSecond = vi.getTimerCount() - baseline;
    await vi.advanceTimersByTimeAsync(20_000);

    expect({ afterFirst, afterSecond, listTimes: env.fake.listTimes }).toMatchInlineSnapshot(`
      {
        "afterFirst": 1,
        "afterSecond": 1,
        "listTimes": [
          0,
          0,
          1000,
          3000,
          7000,
          15000,
        ],
      }
    `);
    await env.pool.stop();
  });

  it('stop() は残っている予約を clear し、その後は挑み直さない', async () => {
    const env = await build();
    env.fake.listFailure = () => new RunnerHttpError('runner GET /managers が失敗した (503)', 503);
    const baseline = vi.getTimerCount();

    await env.pool.reattachRunner('runner-a');
    const reserved = vi.getTimerCount() - baseline;
    const listsBefore = env.fake.listTimes.length;
    await env.pool.stop();
    const afterStop = vi.getTimerCount() - baseline;
    await vi.advanceTimersByTimeAsync(120_000);

    expect({
      reserved,
      afterStop,
      listsAfterStop: env.fake.listTimes.length - listsBefore,
    }).toMatchInlineSnapshot(`
      {
        "afterStop": 0,
        "listsAfterStop": 0,
        "reserved": 1,
      }
    `);
  });
});

describe('reattach の finally: 処理中に届いた名乗り', () => {
  it('一時的に失敗した回でも、重なった名乗りがあれば予約せず即時にもう1回取り直し、それが通れば予約は残らない', async () => {
    const env = await build();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    env.fake.listGate = {
      entered,
      opened: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    // 1 回目（門の後）だけ一時的に失敗する。
    env.fake.listFailure = (call) =>
      call === 1 ? new RunnerHttpError('runner GET /managers が失敗した (503)', 503) : undefined;
    const baseline = vi.getTimerCount();

    const first = env.pool.reattachRunner('runner-a');
    await enteredPromise;
    await env.pool.reattachRunner('runner-a');
    release();
    await first;
    const afterFirst = {
      listCalls: env.fake.listTimes.length,
      timers: vi.getTimerCount() - baseline,
    };
    await vi.advanceTimersByTimeAsync(120_000);

    expect({
      afterFirst,
      listCalls: env.fake.listTimes.length,
      resumes: env.fake.resumeTimes.length,
      timers: vi.getTimerCount() - baseline,
    }).toMatchInlineSnapshot(`
      {
        "afterFirst": {
          "listCalls": 1,
          "timers": 0,
        },
        "listCalls": 2,
        "resumes": 1,
        "timers": 1,
      }
    `);
    await env.pool.stop();
  });
});

describe('reattach の await の周回数', () => {
  it('名乗りから list が呼ばれるまで・list の失敗から予約が積まれるまで・予約の発火から list が呼ばれるまでの周回数', async () => {
    const env = await build();
    env.fake.listFailure = () => new RunnerHttpError('runner GET /managers が失敗した (503)', 503);
    const baseline = vi.getTimerCount();

    // 名乗り → list が呼ばれるまで、list が落ちる → 予約が積まれるまで。
    void env.pool.reattachRunner('runner-a');
    const listAt = await ticksUntil(() => env.fake.listTimes.length === 1);
    const reservedAt = listAt + (await ticksUntil(() => vi.getTimerCount() > baseline));

    // 予約の発火（同期で進める）→ list が呼ばれるまで、list が落ちる → 次の予約が積まれるまで。
    const timerCountBeforeFire = vi.getTimerCount();
    vi.advanceTimersByTime(1_000);
    const firedListAt = await ticksUntil(() => env.fake.listTimes.length === 2);
    const rereservedAt =
      firedListAt + (await ticksUntil(() => vi.getTimerCount() === timerCountBeforeFire));

    expect({ listAt, reservedAt, firedListAt, rereservedAt }).toMatchInlineSnapshot(`
      {
        "firedListAt": 15,
        "listAt": 15,
        "rereservedAt": 17,
        "reservedAt": 17,
      }
    `);
    await env.pool.stop();
  });

  it('処理中に重なった名乗りの再実行が、門が開いてから list を呼ぶまでの周回数', async () => {
    const env = await build();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    env.fake.listGate = {
      entered,
      opened: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };

    const first = env.pool.reattachRunner('runner-a');
    await enteredPromise;
    await env.pool.reattachRunner('runner-a');
    expect(env.fake.listTimes.length).toBe(1);
    release();
    // 門が開いてから: 1 回目が終わる → finally が2回目を起こす → 2回目の list が呼ばれる、までの周回数。
    const secondListAt = await ticksUntil(() => env.fake.listTimes.length === 2);
    await first;

    expect({ secondListAt }).toMatchInlineSnapshot(`
      {
        "secondListAt": 40,
      }
    `);
    await env.pool.stop();
  });
});

describe('reattach: resume の失敗の仕分け（#classifyReattachError）', () => {
  const cases: { label: string; error: unknown }[] = [
    { label: 'status 無しの失敗（fetch failed 相当）', error: new Error('fetch failed') },
    { label: '408', error: new RunnerHttpError('timeout', 408) },
    { label: '429', error: new RunnerHttpError('busy', 429) },
    { label: '500', error: new RunnerHttpError('server', 500) },
    { label: '503', error: new RunnerHttpError('unavailable', 503) },
    { label: '400', error: new RunnerHttpError('bad request', 400) },
    { label: '401', error: new RunnerHttpError('unauthorized', 401) },
    { label: '403', error: new RunnerHttpError('forbidden', 403) },
    { label: '404', error: new RunnerHttpError('not found', 404) },
    { label: '409（世代で拒まれた）', error: new RunnerHttpError('fenced', 409) },
    { label: '422', error: new RunnerHttpError('unprocessable', 422) },
    { label: '499', error: new RunnerHttpError('client closed', 499) },
  ];

  it('一時的な失敗だけが予約され、409 は状態を動かさず止め、それ以外は lost に確定して二度と挑まない', async () => {
    const table: Record<string, unknown> = {};
    for (const { label, error } of cases) {
      const env = await build();
      env.fake.resumeFailure = () => error;

      await env.pool.reattachRunner('runner-a');
      const reservedAfterFirst = env.fake.resumeTimes.length;
      await vi.advanceTimersByTimeAsync(130_000);
      await env.pool.stop();

      const job = await env.stores.jobs.getJob('mgr-1');
      const decisions = await journalDecisions(env.stores);
      const notices = noticeTexts(env.inbox);
      table[label] = {
        attemptsIn130s: env.fake.resumeTimes.length,
        retriedAfterFirst: env.fake.resumeTimes.length > reservedAfterFirst,
        status: job?.status,
        notice: notices.some((text) => text.includes('新しく起こし直さないでください'))
          ? 'fenced'
          : notices.some((text) => text.includes('戻せなかった'))
            ? 'lost'
            : 'none',
        fencedDecision: decisions.some((text) => text.includes('取り直しを止めた')),
      };
      vi.useRealTimers();
    }
    expect(table).toMatchInlineSnapshot(`
      {
        "400": {
          "attemptsIn130s": 1,
          "fencedDecision": false,
          "notice": "lost",
          "retriedAfterFirst": false,
          "status": "lost",
        },
        "401": {
          "attemptsIn130s": 1,
          "fencedDecision": false,
          "notice": "lost",
          "retriedAfterFirst": false,
          "status": "lost",
        },
        "403": {
          "attemptsIn130s": 1,
          "fencedDecision": false,
          "notice": "lost",
          "retriedAfterFirst": false,
          "status": "lost",
        },
        "404": {
          "attemptsIn130s": 1,
          "fencedDecision": false,
          "notice": "lost",
          "retriedAfterFirst": false,
          "status": "lost",
        },
        "408": {
          "attemptsIn130s": 9,
          "fencedDecision": false,
          "notice": "none",
          "retriedAfterFirst": true,
          "status": "running",
        },
        "409（世代で拒まれた）": {
          "attemptsIn130s": 1,
          "fencedDecision": true,
          "notice": "fenced",
          "retriedAfterFirst": false,
          "status": "running",
        },
        "422": {
          "attemptsIn130s": 1,
          "fencedDecision": false,
          "notice": "lost",
          "retriedAfterFirst": false,
          "status": "lost",
        },
        "429": {
          "attemptsIn130s": 9,
          "fencedDecision": false,
          "notice": "none",
          "retriedAfterFirst": true,
          "status": "running",
        },
        "499": {
          "attemptsIn130s": 1,
          "fencedDecision": false,
          "notice": "lost",
          "retriedAfterFirst": false,
          "status": "lost",
        },
        "500": {
          "attemptsIn130s": 9,
          "fencedDecision": false,
          "notice": "none",
          "retriedAfterFirst": true,
          "status": "running",
        },
        "503": {
          "attemptsIn130s": 9,
          "fencedDecision": false,
          "notice": "none",
          "retriedAfterFirst": true,
          "status": "running",
        },
        "status 無しの失敗（fetch failed 相当）": {
          "attemptsIn130s": 9,
          "fencedDecision": false,
          "notice": "none",
          "retriedAfterFirst": true,
          "status": "running",
        },
      }
    `);
  });
});

describe('reattach: resume の結果から挑み直しの要否（#reattachOne）', () => {
  it('unreadable（預かった生ログを読めない）は予約して挑み直し、読めるようになった回で戻る（lost にしない）', async () => {
    let unreadable = true;
    const loads: number[] = [];
    const env = await build({
      jobs: [jobOf('mgr-1', { projectKey: 'proj-key' })],
      wrapStores: (stores) => ({
        ...stores,
        sessionStore: {
          append: async () => undefined,
          load: async () => {
            loads.push(Date.now() - CLOCK);
            if (unreadable) throw new Error('台帳の生ログが一時的に読めない');
            return null;
          },
        },
      }),
    });

    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(3_000);
    const whileBroken = {
      loads: [...loads],
      resumes: env.fake.resumeTimes.length,
      status: (await env.stores.jobs.getJob('mgr-1'))?.status,
    };
    unreadable = false;
    await vi.advanceTimersByTimeAsync(10_000);

    expect({
      whileBroken,
      loads,
      resumeTimes: env.fake.resumeTimes,
      status: (await env.stores.jobs.getJob('mgr-1'))?.status,
    }).toMatchInlineSnapshot(`
      {
        "loads": [
          0,
          1000,
          3000,
          7000,
        ],
        "resumeTimes": [
          7000,
        ],
        "status": "running",
        "whileBroken": {
          "loads": [
            0,
            1000,
            3000,
          ],
          "resumes": 0,
          "status": "running",
        },
      }
    `);
    await env.pool.stop();
  });

  it('held-by-lease（前の器の貸し出しが生きている）は梯子で挑み直し続け、待っていることの日誌は1回だけで、猶予が過ぎた回に引き取る', async () => {
    const env = await build({
      jobs: [
        jobOf('mgr-1', {
          lease: {
            runnerId: 'runner-a',
            instanceId: 'boot-1',
            fence: 4,
            grantedAt: new Date(CLOCK - 2_000).toISOString(),
            seenAt: new Date(CLOCK - 1_000).toISOString(),
            ttlMs: 10 * 60_000,
          },
        }),
      ],
      entries: [
        entryOf('runner-a', {
          instanceId: 'boot-2',
          instanceSince: new Date(CLOCK).toISOString(),
        }),
      ],
    });

    await env.pool.reattachRunner('runner-a');
    expect(env.fake.resumeTimes).toEqual([]);
    await vi.advanceTimersByTimeAsync(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 40_000);

    const decisions = await journalDecisions(env.stores);
    expect({
      listTimes: env.fake.listTimes,
      resumeTimes: env.fake.resumeTimes,
      waitingDecisions: decisions.filter((text) => text.includes('引き取りを見送った')).length,
      takenOver: decisions.filter((text) => text.includes('引き取った')).length,
      status: (await env.stores.jobs.getJob('mgr-1'))?.status,
    }).toMatchInlineSnapshot(`
      {
        "listTimes": [
          0,
          1000,
          3000,
          7000,
          15000,
          31000,
          61000,
          91000,
        ],
        "resumeTimes": [
          91000,
        ],
        "status": "running",
        "takenOver": 1,
        "waitingDecisions": 1,
      }
    `);
    await env.pool.stop();
  });
});

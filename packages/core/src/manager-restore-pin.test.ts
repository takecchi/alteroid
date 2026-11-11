import { afterEach, describe, expect, it, vi } from 'vitest';

import { LEASE_DRAIN_MS, LEASE_MARGIN_MS } from './lease.js';
import { createManagerPool, type ManagerPool, type ManagerTokenAssignmentPort } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import { RunnerHttpError } from './runner-protocol.js';
import type {
  RunnerClient,
  RunnerEntry,
  RunnerEvent,
  RunnerManagerState,
} from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 仕様を先に書いたものではなく、今の出力から変えないための歯。
// `Pool#restore`（起動時の引き取り: `#restoreExclusive`・`#restoreJobs`・`#adoptLiving`・`#resumeAfterRestart`・
// `#settleResumedAfterRestart`・`#restoredSummaryOf`）のうち、既存の試験が縛っていない枝を、外から見える結果だけで縛る。
// 期待は今の出力を `-u` でインライン snapshot に生成して目で読んだもの。
//   - resume の失敗の仕分け（一時的 → 梯子へ予約・世代で拒まれた → 止める・それ以外 → lost）と、`held-by-lease` の見送り
//   - resume の受理後の書き戻し（cwd が倒れた回の一言と日誌・一言の送信が落ちても進むこと）
//   - 生きたセッションの引き取り（runner の答えの status ごとの `attached`・宛先と cwd の揃え・鍵の指紋）
//   - `restore()` の直列化（`#restoreQueue`）と、`#restoring` を `reattachRunner` が待つこと、`await` の周回数
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

function stateOf(
  managerId: string,
  overrides: Partial<RunnerManagerState> = {},
): RunnerManagerState {
  return {
    liveBackgroundTasks: 0,
    managerId,
    status: 'running',
    cwd: '/work/project',
    request: '続きをやって',
    waiting: [],
    sessionId: `sess-${managerId}`,
    ...overrides,
  };
}

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

/** `list` / `resume` を呼ばれた回（1 始まり）で失敗させられる偽の runner。時刻は fake timer の `Date.now()`。 */
interface Fake {
  client: RunnerClient;
  /** 呼ばれた順の記録（`list` / `resume` / `send`）。 */
  log: string[];
  listTimes: number[];
  resumeTimes: number[];
  sends: string[];
  sessions: Map<string, RunnerManagerState>;
  /** 返した値を投げる（`undefined` なら通す）。 */
  resumeFailure?: (call: number) => unknown;
  /** 指定すると、`resume` の応答の cwd をこの値にする（倒れた回）。 */
  resumeCwd?: string;
  /** 真なら `send` が失敗する。 */
  sendFails?: boolean;
  /** `list` の呼びごとに先頭から1つ取り、その門が開くまで返らない。 */
  listGates: Gate[];
  resumeGate?: Gate;
  /** `list` の呼びごとに先頭から1つ取り、あれば投げる。 */
  listFailures: unknown[];
  emit: (event: RunnerEvent) => void;
}

function fakeRunner(runnerId: string): Fake {
  const holder: { emit?: (event: RunnerEvent) => void } = {};
  const fake: Fake = {
    log: [],
    listTimes: [],
    resumeTimes: [],
    sends: [],
    sessions: new Map(),
    listGates: [],
    listFailures: [],
    client: undefined as unknown as RunnerClient,
    emit: (event) => {
      if (holder.emit === undefined) throw new Error('まだ接続されていない');
      holder.emit(event);
    },
  };
  fake.client = fakeRunnerClient({
    runnerId,
    async connect(onEvent) {
      holder.emit = onEvent;
    },
    async resume(command) {
      fake.log.push(`resume:${command.managerId}`);
      fake.resumeTimes.push(Date.now() - CLOCK);
      if (fake.resumeGate !== undefined) {
        fake.resumeGate.markEntered();
        await fake.resumeGate.opened;
      }
      const failure = fake.resumeFailure?.(fake.resumeTimes.length);
      if (failure !== undefined) throw failure;
      fake.sessions.set(command.managerId, stateOf(command.managerId));
      return { cwd: fake.resumeCwd ?? command.cwd };
    },
    async send(_managerId, text) {
      fake.log.push('send');
      fake.sends.push(text);
      if (fake.sendFails === true) throw new Error('send が落ちた');
      return true;
    },
    async list() {
      fake.log.push('list');
      fake.listTimes.push(Date.now() - CLOCK);
      const listGate = fake.listGates.shift();
      if (listGate !== undefined) {
        listGate.markEntered();
        await listGate.opened;
      }
      const failure = fake.listFailures.shift();
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
}

async function build(
  options: {
    jobs?: Job[];
    entries?: RunnerEntry[];
    wrapStores?: (stores: Stores) => Stores;
    tokenIdentity?: () => { tokenId: string; generation: number; fingerprint?: string };
    tokenAssignment?: ManagerTokenAssignmentPort;
  } = {},
): Promise<Env> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(CLOCK);
  const fake = fakeRunner('runner-a');
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
    ...(options.tokenIdentity === undefined ? {} : { tokenIdentity: options.tokenIdentity }),
    ...(options.tokenAssignment === undefined ? {} : { tokenAssignment: options.tokenAssignment }),
  });
  return { pool, stores, fake, inbox };
}

/** 有界の回数だけ `await Promise.resolve()` を回し、条件が初めて真になった回（0 始まり）を返す。 */
async function ticksUntil(condition: () => boolean, bound = 300): Promise<number> {
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

async function journalText(stores: Stores): Promise<string> {
  const entries = await stores.journal.list({});
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

function noticeTexts(inbox: readonly InboxEvent[]): string[] {
  return inbox.flatMap((event) => (event.type === 'manager_message' ? [event.text] : []));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('restore: resume の失敗の仕分け（#resumeAfterRestart の catch）', () => {
  const cases: { label: string; error: unknown }[] = [
    { label: 'status 無しの失敗（fetch failed 相当）', error: new Error('fetch failed') },
    { label: '408', error: new RunnerHttpError('timeout', 408) },
    { label: '503', error: new RunnerHttpError('unavailable', 503) },
    { label: '400', error: new RunnerHttpError('bad request', 400) },
    { label: '404', error: new RunnerHttpError('not found', 404) },
    { label: '409（世代で拒まれた）', error: new RunnerHttpError('fenced', 409) },
  ];

  it('一時的な失敗だけが梯子へ予約され、409 は状態を動かさず止め、それ以外は lost に確定して二度と挑まない', async () => {
    const table: Record<string, unknown> = {};
    for (const { label, error } of cases) {
      const env = await build();
      env.fake.resumeFailure = () => error;
      const baseline = vi.getTimerCount();

      const restored = await env.pool.restore();
      const reservedTimers = vi.getTimerCount() - baseline;
      const attemptsAtRestore = env.fake.resumeTimes.length;
      await vi.advanceTimersByTimeAsync(130_000);
      await env.pool.stop();

      const job = await env.stores.jobs.getJob('mgr-1');
      const listed = (await env.pool.list()).find((summary) => summary.managerId === 'mgr-1');
      const decisions = await journalDecisions(env.stores);
      const notices = noticeTexts(env.inbox);
      table[label] = {
        returned: restored.length,
        attemptsAtRestore,
        attemptsIn130s: env.fake.resumeTimes.length,
        reservedTimers,
        ledgerStatus: job?.status,
        listedStatus: listed?.status,
        listedLive: listed?.live,
        notice: notices.some((text) => text.includes('新しく起こし直さないでください'))
          ? 'fenced'
          : notices.some((text) => text.includes('戻せなかった'))
            ? 'lost'
            : 'none',
        fencedDecision: decisions.filter((text) => text.includes('起動時の引き取りを止めた'))
          .length,
        lostJournal: (await journalText(env.stores)).includes('戻せなかった'),
      };
      vi.useRealTimers();
    }
    expect(table).toMatchInlineSnapshot(`
      {
        "400": {
          "attemptsAtRestore": 1,
          "attemptsIn130s": 1,
          "fencedDecision": 0,
          "ledgerStatus": "lost",
          "listedLive": false,
          "listedStatus": "lost",
          "lostJournal": true,
          "notice": "lost",
          "reservedTimers": 1,
          "returned": 0,
        },
        "404": {
          "attemptsAtRestore": 1,
          "attemptsIn130s": 1,
          "fencedDecision": 0,
          "ledgerStatus": "lost",
          "listedLive": false,
          "listedStatus": "lost",
          "lostJournal": true,
          "notice": "lost",
          "reservedTimers": 1,
          "returned": 0,
        },
        "408": {
          "attemptsAtRestore": 1,
          "attemptsIn130s": 9,
          "fencedDecision": 0,
          "ledgerStatus": "running",
          "listedLive": true,
          "listedStatus": "running",
          "lostJournal": false,
          "notice": "none",
          "reservedTimers": 1,
          "returned": 0,
        },
        "409（世代で拒まれた）": {
          "attemptsAtRestore": 1,
          "attemptsIn130s": 1,
          "fencedDecision": 1,
          "ledgerStatus": "running",
          "listedLive": true,
          "listedStatus": "running",
          "lostJournal": false,
          "notice": "fenced",
          "reservedTimers": 0,
          "returned": 0,
        },
        "503": {
          "attemptsAtRestore": 1,
          "attemptsIn130s": 9,
          "fencedDecision": 0,
          "ledgerStatus": "running",
          "listedLive": true,
          "listedStatus": "running",
          "lostJournal": false,
          "notice": "none",
          "reservedTimers": 1,
          "returned": 0,
        },
        "status 無しの失敗（fetch failed 相当）": {
          "attemptsAtRestore": 1,
          "attemptsIn130s": 9,
          "fencedDecision": 0,
          "ledgerStatus": "running",
          "listedLive": true,
          "listedStatus": "running",
          "lostJournal": false,
          "notice": "none",
          "reservedTimers": 1,
          "returned": 0,
        },
      }
    `);
  });

  it('一時的な失敗は梯子へ載り、1 秒から倍々の間隔で resume を挑み直す', async () => {
    const env = await build();
    env.fake.resumeFailure = () => new RunnerHttpError('unavailable', 503);

    await env.pool.restore();
    await vi.advanceTimersByTimeAsync(40_000);

    expect(env.fake.resumeTimes).toMatchInlineSnapshot(`
      [
        0,
        1000,
        3000,
        7000,
        15000,
        31000,
      ]
    `);
    await env.pool.stop();
  });

  it('一時的な失敗の後、次の回の resume が通れば像は running のまま戻り、それ以上は挑まない', async () => {
    const env = await build();
    env.fake.resumeFailure = (call) => (call === 1 ? new Error('fetch failed') : undefined);

    const first = await env.pool.restore();
    await vi.advanceTimersByTimeAsync(60_000);

    expect({
      first: first.map((summary) => summary.managerId),
      resumeTimes: env.fake.resumeTimes,
      status: (await env.stores.jobs.getJob('mgr-1'))?.status,
    }).toMatchInlineSnapshot(`
      {
        "first": [],
        "resumeTimes": [
          0,
          1000,
        ],
        "status": "running",
      }
    `);
    await env.pool.stop();
  });

  it('貸し出しが生きていて断られた（held-by-lease）回は、見送りの日誌を1回書いて梯子へ載り、猶予が過ぎた回に引き取る', async () => {
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
    const baseline = vi.getTimerCount();

    const restored = await env.pool.restore();
    const atRestore = {
      returned: restored.length,
      resumes: env.fake.resumeTimes.length,
      timers: vi.getTimerCount() - baseline,
    };
    await vi.advanceTimersByTimeAsync(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 40_000);

    const decisions = await journalDecisions(env.stores);
    expect({
      atRestore,
      resumeTimes: env.fake.resumeTimes,
      waitingDecisions: decisions.filter((text) => text.includes('引き取りを見送った')).length,
      status: (await env.stores.jobs.getJob('mgr-1'))?.status,
    }).toMatchInlineSnapshot(`
      {
        "atRestore": {
          "resumes": 0,
          "returned": 0,
          "timers": 1,
        },
        "resumeTimes": [
          91000,
        ],
        "status": "running",
        "waitingDecisions": 1,
      }
    `);
    await env.pool.stop();
  });
});

describe('restore: resume の受理後の書き戻し（#settleResumedAfterRestart）', () => {
  it('通常の受理: running を書き、再開の一言は送らず、日誌に再開の文面を1本残し、戻り値に載せる', async () => {
    const env = await build();

    const restored = await env.pool.restore();

    const exchanges = (await journalText(env.stores))
      .split('\n')
      .filter((line) => line.includes('再起動後の再開'));
    expect({
      returned: restored.map((summary) => [summary.managerId, summary.status, summary.live]),
      sends: env.fake.sends,
      ledgerStatus: (await env.stores.jobs.getJob('mgr-1'))?.status,
      exchanges: exchanges.length,
      exchangeHasSwap: exchanges.some((line) => line.includes('元の cwd')),
    }).toMatchInlineSnapshot(`
      {
        "exchangeHasSwap": false,
        "exchanges": 1,
        "ledgerStatus": "running",
        "returned": [
          [
            "mgr-1",
            "running",
            true,
          ],
        ],
        "sends": [],
      }
    `);
    await env.pool.stop();
  });

  it('cwd が倒れた受理: 台帳の cwd を実際の値へ直し、runner へ一言を送り、日誌の文面に同じ一言を足す', async () => {
    const env = await build();
    env.fake.resumeCwd = '/work/fallback';

    const restored = await env.pool.restore();

    const exchanges = (await journalText(env.stores))
      .split('\n')
      .filter((line) => line.includes('再起動後の再開'));
    expect({
      returnedCwd: restored.map((summary) => summary.cwd),
      sends: env.fake.sends,
      ledgerCwd: (await env.stores.jobs.getJob('mgr-1'))?.cwd,
      exchanges: exchanges.length,
      exchangeHasSwap: exchanges.some((line) => line.includes('元の cwd')),
    }).toMatchInlineSnapshot(`
      {
        "exchangeHasSwap": true,
        "exchanges": 1,
        "ledgerCwd": "/work/fallback",
        "returnedCwd": [
          "/work/fallback",
        ],
        "sends": [
          "[system] 元の cwd（/work/project）はこの器に無かったので、/work/fallback で開いた。",
        ],
      }
    `);
    await env.pool.stop();
  });

  it('cwd が倒れ、一言の送信が落ちても、受理は進み、日誌も戻り値も残る', async () => {
    const env = await build();
    env.fake.resumeCwd = '/work/fallback';
    env.fake.sendFails = true;

    const restored = await env.pool.restore();

    expect({
      returned: restored.map((summary) => [summary.managerId, summary.status]),
      sends: env.fake.sends,
      ledgerStatus: (await env.stores.jobs.getJob('mgr-1'))?.status,
      journalHasResume: (await journalText(env.stores)).includes('再起動後の再開'),
    }).toMatchInlineSnapshot(`
      {
        "journalHasResume": true,
        "ledgerStatus": "running",
        "returned": [
          [
            "mgr-1",
            "running",
          ],
        ],
        "sends": [
          "[system] 元の cwd（/work/project）はこの器に無かったので、/work/fallback で開いた。",
        ],
      }
    `);
    await env.pool.stop();
  });

  it('応答より先に確認待ちが届いた回は waiting_human を保ち、戻り値にも待ちを載せる', async () => {
    const env = await build();
    env.fake.resumeGate = gate();

    const restoring = env.pool.restore();
    await env.fake.resumeGate.entered;
    env.fake.emit({
      type: 'ask',
      managerId: 'mgr-1',
      requestId: 'ask-1',
      kind: 'permission',
      summary: 'Bash の実行許可（resume の応答より先の確認）',
    } as RunnerEvent);
    await ticksUntil(() => false, 30).catch(() => undefined);
    env.fake.resumeGate.open();
    const restored = await restoring;

    expect({
      returned: restored.map((summary) => [
        summary.managerId,
        summary.status,
        summary.waiting.length,
      ]),
      ledgerStatus: (await env.stores.jobs.getJob('mgr-1'))?.status,
    }).toMatchInlineSnapshot(`
      {
        "ledgerStatus": "waiting_human",
        "returned": [
          [
            "mgr-1",
            "waiting_human",
            1,
          ],
        ],
      }
    `);
    await env.pool.stop();
  });
});

describe('restore: 生きたセッションの引き取り（#adoptLiving）', () => {
  const statuses = ['running', 'waiting_human', 'done', 'failed', 'lost'] as const;

  it('runner の答えの status ごとに、台帳の status・宛先・cwd を runner の値へ揃え、attached は running と waiting_human だけ立てる', async () => {
    const table: Record<string, unknown> = {};
    for (const status of statuses) {
      const env = await build({
        jobs: [jobOf('mgr-1', { cwd: '/work/old', runnerId: undefined })],
      });
      env.fake.sessions.set(
        'mgr-1',
        stateOf('mgr-1', { status, cwd: '/work/opened', sessionId: 'sess-opened' }),
      );

      const restored = await env.pool.restore();
      const job = await env.stores.jobs.getJob('mgr-1');
      // attached かどうかは、次の伝言が生きたセッションへ直接届くか（`runner.send`）、resume を試みるかで見える。
      const sendsBefore = env.fake.sends.length;
      const resumesBefore = env.fake.resumeTimes.length;
      await env.pool.send('mgr-1', '続けて').catch(() => undefined);
      table[status] = {
        returned: restored.map((summary) => [summary.status, summary.cwd, summary.live]),
        ledger: [job?.status, job?.runnerId, job?.cwd, job?.sessionId],
        resumes: env.fake.resumeTimes.length - resumesBefore,
        directSends: env.fake.sends.length - sendsBefore,
        tokenGenerationUnknownReason: restored[0]?.tokenGenerationUnknownReason,
      };
      await env.pool.stop();
      vi.useRealTimers();
    }
    expect(table).toMatchInlineSnapshot(`
      {
        "done": {
          "directSends": 0,
          "ledger": [
            "done",
            "runner-a",
            "/work/opened",
            "sess-opened",
          ],
          "resumes": 1,
          "returned": [
            [
              "done",
              "/work/opened",
              true,
            ],
          ],
          "tokenGenerationUnknownReason": "pool-not-wired",
        },
        "failed": {
          "directSends": 0,
          "ledger": [
            "failed",
            "runner-a",
            "/work/opened",
            "sess-opened",
          ],
          "resumes": 1,
          "returned": [
            [
              "failed",
              "/work/opened",
              true,
            ],
          ],
          "tokenGenerationUnknownReason": "pool-not-wired",
        },
        "lost": {
          "directSends": 0,
          "ledger": [
            "lost",
            "runner-a",
            "/work/opened",
            "sess-opened",
          ],
          "resumes": 1,
          "returned": [
            [
              "lost",
              "/work/opened",
              false,
            ],
          ],
          "tokenGenerationUnknownReason": "pool-not-wired",
        },
        "running": {
          "directSends": 1,
          "ledger": [
            "running",
            "runner-a",
            "/work/opened",
            "sess-opened",
          ],
          "resumes": 0,
          "returned": [
            [
              "running",
              "/work/opened",
              true,
            ],
          ],
          "tokenGenerationUnknownReason": "pool-not-wired",
        },
        "waiting_human": {
          "directSends": 1,
          "ledger": [
            "waiting_human",
            "runner-a",
            "/work/opened",
            "sess-opened",
          ],
          "resumes": 0,
          "returned": [
            [
              "waiting_human",
              "/work/opened",
              true,
            ],
          ],
          "tokenGenerationUnknownReason": "pool-not-wired",
        },
      }
    `);
  });

  it('鍵の指紋を名乗って引き取った委譲は、世代が測れない理由に「引き取り」を名乗り（プール配線あり）、配線が無ければ「配線なし」を名乗る', async () => {
    const rows: Record<string, unknown> = {};
    for (const wired of [true, false]) {
      const env = await build({
        ...(wired
          ? {
              tokenIdentity: () => ({
                tokenId: 'tok-new',
                generation: 3,
                fingerprint: 'bbbbbbbbbbbb',
              }),
            }
          : {}),
      });
      env.fake.sessions.set('mgr-1', stateOf('mgr-1', { tokenFingerprint: 'aaaaaaaaaaaa' }));

      const restored = await env.pool.restore();
      const listed = (await env.pool.list()).find((summary) => summary.managerId === 'mgr-1');
      rows[wired ? 'wired' : 'unwired'] = {
        restored: [
          restored[0]?.tokenGeneration,
          restored[0]?.activeTokenGeneration,
          restored[0]?.tokenGenerationUnknownReason,
        ],
        listed: [listed?.tokenGeneration, listed?.tokenGenerationUnknownReason],
      };
      await env.pool.stop();
      vi.useRealTimers();
    }
    expect(rows).toMatchInlineSnapshot(`
      {
        "unwired": {
          "listed": [
            undefined,
            "pool-not-wired",
          ],
          "restored": [
            undefined,
            undefined,
            "pool-not-wired",
          ],
        },
        "wired": {
          "listed": [
            undefined,
            "reattached-across-restart",
          ],
          "restored": [
            undefined,
            undefined,
            "reattached-across-restart",
          ],
        },
      }
    `);
  });

  it('引き取りは台帳に残った前の鍵と runner の id を手がかりに鍵を割り当て直し、台帳へ割り当ての id を書く', async () => {
    const hints: { managerId: string; prior?: string; container?: string }[] = [];
    const port: ManagerTokenAssignmentPort = {
      async assign(managerId, hint) {
        hints.push({ managerId, ...hint });
        return {
          tokenId: 'tok-b',
          generation: 7,
          fingerprint: 'fp-tok-b',
          value: 'tok-fake-value-b',
        };
      },
      target: () => ({ tokenId: 'tok-b', generation: 7, fingerprint: 'fp-tok-b' }),
    };
    const env = await build({
      tokenAssignment: port,
      jobs: [jobOf('mgr-1', { tokenAssignment: { tokenId: 'tok-a' } })],
    });
    env.fake.sessions.set('mgr-1', stateOf('mgr-1'));

    await env.pool.restore();

    expect({
      hints,
      ledger: (await env.stores.jobs.getJob('mgr-1'))?.tokenAssignment,
    }).toMatchInlineSnapshot(`
      {
        "hints": [
          {
            "container": "runner-a",
            "managerId": "mgr-1",
            "prior": "tok-a",
          },
        ],
        "ledger": {
          "tokenId": "tok-b",
        },
      }
    `);
    await env.pool.stop();
  });

  it('宛先の runner が名簿で lost と読まれていれば、引き取りの要約は live: false と lost の時刻を名乗る', async () => {
    const env = await build({
      entries: [entryOf('runner-a', { state: 'lost', since: '2026-08-31T00:00:00.000Z' })],
    });
    env.fake.sessions.set('mgr-1', stateOf('mgr-1'));

    const restored = await env.pool.restore();

    expect(restored.map((summary) => [summary.status, summary.live, summary.runnerLostSince]))
      .toMatchInlineSnapshot(`
      [
        [
          "running",
          false,
          "2026-08-31T00:00:00.000Z",
        ],
      ]
    `);
    await env.pool.stop();
  });

  it('確認を抱えたまま引き取った委譲は、attached なら確認を1回知らせ直し、attached でない（done）なら知らせ直さない', async () => {
    const rows: Record<string, unknown> = {};
    for (const status of ['waiting_human', 'running', 'done'] as const) {
      const env = await build();
      env.fake.sessions.set(
        'mgr-1',
        stateOf('mgr-1', {
          status,
          waiting: [{ requestId: 'req-1', kind: 'permission', summary: 'Bash の実行許可' }],
        } as Partial<RunnerManagerState>),
      );

      await env.pool.restore();
      await vi.advanceTimersByTimeAsync(60_000);
      rows[status] = noticeTexts(env.inbox).filter((text) =>
        text.includes('Bash の実行許可'),
      ).length;
      await env.pool.stop();
      vi.useRealTimers();
    }
    expect(rows).toMatchInlineSnapshot(`
      {
        "done": 0,
        "running": 1,
        "waiting_human": 1,
      }
    `);
  });

  it('宛先の無い委譲は、聞けなかった器が1台でもあれば触らず、聞けた回で拾い直す', async () => {
    const env = await build({ jobs: [jobOf('mgr-1', { runnerId: undefined })] });
    env.fake.listFailures.push(new Error('fetch failed'));

    const first = await env.pool.restore();
    const resumesAfterFirst = env.fake.resumeTimes.length;
    const second = await env.pool.restore();

    expect({
      first: first.length,
      resumesAfterFirst,
      second: second.map((summary) => summary.managerId),
    }).toMatchInlineSnapshot(`
      {
        "first": 0,
        "resumesAfterFirst": 0,
        "second": [
          "mgr-1",
        ],
      }
    `);
    await env.pool.stop();
  });

  it('状態を読めなかったが居る委譲を引き取った像も、世代が測れない理由に「引き取り」を名乗る', async () => {
    const env = await build({
      tokenIdentity: () => ({ tokenId: 'tok-new', generation: 3 }),
      jobs: [jobOf('mgr-1', { runnerId: undefined })],
    });
    env.fake.client.listWithUnreadable = async () => ({ states: [], unreadableIds: ['mgr-1'] });

    const restored = await env.pool.restore();
    const listed = (await env.pool.list()).find((summary) => summary.managerId === 'mgr-1');

    expect({
      returned: restored.length,
      listed: [listed?.status, listed?.runnerId, listed?.tokenGenerationUnknownReason],
    }).toMatchInlineSnapshot(`
      {
        "listed": [
          "running",
          "runner-a",
          "reattached-across-restart",
        ],
        "returned": 0,
      }
    `);
    await env.pool.stop();
  });
});

describe('restore: 直列化（#restoreQueue）と #restoring', () => {
  it('2本の restore が重なっても、後の呼びは先の呼びが終わるまで runner に聞かず、同じ委譲を二重に起こさない', async () => {
    const env = await build();
    const listGate = gate();
    env.fake.listGates.push(listGate);

    const first = env.pool.restore();
    await listGate.entered;
    const second = env.pool.restore();
    // 先の呼びが list で止まっている間、後の呼びが動き出すのに十分な回数を回す。
    for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
    const listsWhileFirstIsBlocked = env.fake.log.filter((line) => line === 'list').length;
    listGate.open();
    const [a, b] = await Promise.all([first, second]);

    expect({
      listsWhileFirstIsBlocked,
      log: env.fake.log,
      first: a.map((summary) => summary.managerId),
      second: b.map((summary) => summary.managerId),
    }).toMatchInlineSnapshot(`
      {
        "first": [
          "mgr-1",
        ],
        "listsWhileFirstIsBlocked": 1,
        "log": [
          "list",
          "resume:mgr-1",
          "list",
        ],
        "second": [],
      }
    `);
    await env.pool.stop();
  });

  it('先の restore が resume で止まっている間、後の restore の list は呼ばれず、先が終わってから周回数の有界のうちに呼ばれる', async () => {
    const env = await build({ jobs: [jobOf('mgr-1'), jobOf('mgr-2')] });
    env.fake.resumeGate = gate();

    const first = env.pool.restore();
    await env.fake.resumeGate.entered;
    const second = env.pool.restore();
    for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
    const listsWhileBlocked = env.fake.listTimes.length;
    env.fake.resumeGate.open();
    const secondListAt = await ticksUntil(() => env.fake.listTimes.length === 2);
    await Promise.all([first, second]);

    expect({ listsWhileBlocked, secondListAt, log: env.fake.log }).toMatchInlineSnapshot(`
      {
        "listsWhileBlocked": 1,
        "log": [
          "list",
          "resume:mgr-1",
          "resume:mgr-2",
          "list",
        ],
        "secondListAt": 51,
      }
    `);
    await env.pool.stop();
  });

  it('先の restore が投げても、後の restore は列から外れず走る（先の失敗を後へ持ち越さない）', async () => {
    let broken = true;
    const env = await build({
      wrapStores: (stores) => ({
        ...stores,
        jobs: {
          ...stores.jobs,
          listJobs: async (...args) => {
            if (broken) throw new Error('台帳が一時的に読めない');
            return stores.jobs.listJobs(...args);
          },
        },
      }),
    });

    const first = env.pool.restore().then(
      (value) => ({ resolved: value.length }),
      (error: unknown) => {
        broken = false;
        return { rejected: (error as Error).message };
      },
    );
    const second = env.pool.restore();
    const results = await Promise.all([first, second]);

    expect({
      first: results[0],
      second: results[1].map((summary) => summary.managerId),
    }).toMatchInlineSnapshot(`
      {
        "first": {
          "rejected": "台帳が一時的に読めない",
        },
        "second": [
          "mgr-1",
        ],
      }
    `);
    await env.pool.stop();
  });

  it('restore の最中の reattachRunner は、restore が終わるまで runner に聞かず、終わってから取り直す', async () => {
    const env = await build();
    env.fake.resumeGate = gate();

    const restoring = env.pool.restore();
    await env.fake.resumeGate.entered;
    const listsBefore = env.fake.listTimes.length;
    const reattaching = env.pool.reattachRunner('runner-a');
    for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
    const listsWhileRestoring = env.fake.listTimes.length;
    env.fake.resumeGate.open();
    const reattachListAt = await ticksUntil(() => env.fake.listTimes.length === listsBefore + 1);
    await Promise.all([restoring, reattaching]);

    expect({
      listsBefore,
      listsWhileRestoring,
      reattachListAt,
      log: env.fake.log,
    }).toMatchInlineSnapshot(`
      {
        "listsBefore": 1,
        "listsWhileRestoring": 1,
        "log": [
          "list",
          "resume:mgr-1",
          "list",
        ],
        "reattachListAt": 29,
      }
    `);
    await env.pool.stop();
  });

  it('restore() を呼んだ同じ tick に reattachRunner を呼ぶと、旗が立つ前なので待たずに list へ進む（現状の固定）', async () => {
    const env = await build();
    const firstList = gate();
    env.fake.listGates.push(firstList);

    const restoring = env.pool.restore();
    const reattaching = env.pool.reattachRunner('runner-a');
    for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
    const logWhileBlocked = [...env.fake.log];
    firstList.open();
    await Promise.all([restoring, reattaching]);

    expect({ logWhileBlocked, log: env.fake.log }).toMatchInlineSnapshot(`
      {
        "log": [
          "list",
          "list",
          "resume:mgr-1",
        ],
        "logWhileBlocked": [
          "list",
          "list",
          "resume:mgr-1",
        ],
      }
    `);
    await env.pool.stop();
  });

  it('restore が投げて終わった後の reattachRunner は待たされない（#restoring を必ず下ろす）', async () => {
    let broken = true;
    const env = await build({
      wrapStores: (stores) => ({
        ...stores,
        jobs: {
          ...stores.jobs,
          listJobs: async (...args) => {
            if (broken) throw new Error('台帳が一時的に読めない');
            return stores.jobs.listJobs(...args);
          },
        },
      }),
    });

    const rejected = await env.pool.restore().then(
      () => 'resolved',
      () => 'rejected',
    );
    broken = false;
    const listsBefore = env.fake.listTimes.length;
    const reattaching = env.pool.reattachRunner('runner-a');
    const listAt = await ticksUntil(() => env.fake.listTimes.length === listsBefore + 1);
    await reattaching;

    expect({ rejected, listsBefore, listAt, log: env.fake.log }).toMatchInlineSnapshot(`
      {
        "listAt": 17,
        "listsBefore": 1,
        "log": [
          "list",
          "list",
          "resume:mgr-1",
        ],
        "rejected": "rejected",
      }
    `);
    await env.pool.stop();
  });
});

describe('restore: 引き取りの走査の途中の分岐', () => {
  it('聞けなかった器の委譲は像を載せず resume もせず、聞けた回で拾い直す', async () => {
    const env = await build({ jobs: [jobOf('mgr-1')] });
    env.fake.listFailures.push(new Error('fetch failed'));

    const first = await env.pool.restore();
    const listedAfterFirst = (await env.pool.list()).find(
      (summary) => summary.managerId === 'mgr-1',
    );
    const resumesAfterFirst = env.fake.resumeTimes.length;
    const second = await env.pool.restore();

    expect({
      first: first.length,
      resumesAfterFirst,
      listedAfterFirstLive: listedAfterFirst?.live,
      second: second.map((summary) => summary.managerId),
      resumesAfterSecond: env.fake.resumeTimes.length,
    }).toMatchInlineSnapshot(`
      {
        "first": 0,
        "listedAfterFirstLive": true,
        "resumesAfterFirst": 0,
        "resumesAfterSecond": 1,
        "second": [
          "mgr-1",
        ],
      }
    `);
    await env.pool.stop();
  });
});

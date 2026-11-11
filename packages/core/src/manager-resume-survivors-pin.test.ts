import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import { fakeRunnerClient, FakeRunnerClientBase } from './runner-client.test-support.js';
import {
  createRunnerRegistry,
  RunnerHttpError,
  type RunnerClient,
  type RunnerEntry,
  type RunnerEvent,
  type RunnerLiveness,
  type RunnerManagerState,
  type RunnerRegistry,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { InboxEvent, Job, JobLease } from './schema.js';
import { createMemoryStores } from './testing.js';

// これは仕様を先に書いたものではなく、今の出力から変えないための歯である。
// `ManagerResume`（`manager-resume.ts`）の切り出しの変異試験で、core の全試験でも生き残った枝のうち、外から（本物の `Pool` に偽 runner を繋いで）縛れるものを縛る:
//   M14 `#recordResumed` の `unresumable.delete` / M16 `#claimForResume` の `delete record.leaseRefusal` / M18 `#resume` の `onClaimed?.()`。
// M21・M22（`restored.end`）は外から見える差が無く縛れていない（末尾の注を参照）。

// ---- 実の名簿 + 偽 runner: M14 ----

class LeasedRunner extends FakeRunnerClientBase {
  readonly runnerId = 'runner-primary';
  readonly sessions = new Map<string, RunnerManagerState>();
  readonly resumes: RunnerResumeCommand[] = [];
  instanceId: string | undefined = 'boot-2';
  resumeFailure: unknown;
  emit: ((event: RunnerEvent) => void) | undefined;

  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    return {
      runnerId: this.runnerId,
      ...(this.instanceId === undefined ? {} : { instanceId: this.instanceId }),
    };
  }
  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    this.emit = onEvent;
  }
  async resume(command: RunnerResumeCommand): Promise<{ cwd: string }> {
    if (this.resumeFailure !== undefined) throw this.resumeFailure;
    this.resumes.push(command);
    this.sessions.set(command.managerId, {
      liveBackgroundTasks: 0,
      managerId: command.managerId,
      status: 'running',
      cwd: command.cwd,
      request: command.request,
      waiting: [],
      sessionId: command.sessionId,
    });
    return { cwd: command.cwd };
  }
  async send(): Promise<boolean> {
    return true;
  }
  async stop(managerId: string): Promise<void> {
    this.sessions.delete(managerId);
  }
  async list(): Promise<RunnerManagerState[]> {
    return [...this.sessions.values()];
  }
}

async function leaseHarness(job: Job): Promise<{
  pool: ManagerPool;
  runner: LeasedRunner;
  stores: ReturnType<typeof createMemoryStores>;
  advance: (ms: number) => void;
  decisions: () => Promise<string[]>;
  close: () => Promise<void>;
}> {
  const runner = new LeasedRunner();
  const registry = createRunnerRegistry();
  await registry.register({ label: 'http://runner:4518', open: async () => runner });
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);
  let clock = Date.now();
  const pool = createManagerPool({
    stores,
    post: () => {},
    runners: registry,
    now: () => clock,
  });
  return {
    pool,
    runner,
    stores,
    advance: (ms) => {
      clock += ms;
    },
    decisions: async () =>
      (await stores.journal.list({ limit: 100 })).flatMap((entry) =>
        entry.type === 'decision' ? [entry.decision] : [],
      ),
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

function runningJob(lease?: JobLease): Job {
  const at = new Date(Date.now() - 1_000).toISOString();
  return {
    id: 'mgr-1',
    managerId: 'mgr-1',
    createdAt: at,
    updatedAt: at,
    status: 'running',
    summary: '走っていた仕事',
    request: '走っていた仕事の依頼',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
    ...(lease === undefined ? {} : { lease }),
  };
}

async function statusOf(
  stores: ReturnType<typeof createMemoryStores>,
): Promise<string | undefined> {
  return (await stores.jobs.listJobs()).find((job) => job.id === 'mgr-1')?.status;
}

describe('M14: lost で諦めた後に resume が通ったら、次の取り直しは自動で挑まれる', () => {
  it('lost 確定後は取り直しが挑まない（unresumable が効く）。人間の send で resume が通ると外れ、次の取り直しは挑む', async () => {
    const h = await leaseHarness(runningJob());
    h.runner.resumeFailure = new RunnerHttpError('bad session', 400);

    // 1 回目: 400 で戻れない → lost に確定し、自動の挑み直しの対象から外す。
    await h.pool.reattachRunner('runner-primary');
    expect(await statusOf(h.stores)).toBe('lost');
    expect(h.runner.resumes).toHaveLength(0);

    // 対照: 直しても、lost のままでは取り直しは挑まない（status が非終端でないので `unresumable` を見る前に見送る）。
    h.runner.resumeFailure = undefined;
    await h.pool.reattachRunner('runner-primary');
    expect(h.runner.resumes).toHaveLength(0);

    // 人間が起こし直した: resume が通る。
    const sent = await h.pool.send('mgr-1', '起こし直す');
    expect(sent.outcome).toBe('delivered');
    expect(h.runner.resumes).toHaveLength(1);
    expect(await statusOf(h.stores)).toBe('running');

    // その後で器が入れ替わった（セッションが消えた）: 次の取り直しは `continue` されずに挑む。
    h.runner.sessions.clear();
    await h.pool.reattachRunner('runner-primary');
    expect(h.runner.resumes).toHaveLength(2);

    await h.close();
  });

  it('対照: lost のまま（resume が通らない）なら、起こし直しが失敗した後の取り直しも挑まない', async () => {
    const h = await leaseHarness(runningJob());
    h.runner.resumeFailure = new RunnerHttpError('bad session', 400);
    await h.pool.reattachRunner('runner-primary');
    expect(await statusOf(h.stores)).toBe('lost');

    // 台帳を人手で running へ戻した（resume は通らないまま）: unresumable が残っているので挑まない。
    const job = (await h.stores.jobs.listJobs()).find((j) => j.id === 'mgr-1')!;
    await h.stores.jobs.putJob({ ...job, status: 'running' });
    await h.pool.reattachRunner('runner-primary');
    expect(h.runner.resumes).toHaveLength(0);
    expect(await statusOf(h.stores)).toBe('running');

    await h.close();
  });
});

// ---- 移送（偽の名簿）: M16 と M18 ----

function entryOf(runnerId: string, state: RunnerLiveness): RunnerEntry {
  return {
    label: runnerId,
    state,
    runnerId,
    since: '2026-08-01T00:00:00.000Z',
    lastSeenAt: new Date().toISOString(),
    revision: { status: 'unheard' },
  };
}

interface FakeRunner {
  client: RunnerClient;
  resumes: RunnerResumeCommand[];
  answers: string[];
  sessions: Map<string, RunnerManagerState>;
  failResume: { error: unknown } | undefined;
  emit(event: RunnerEvent): void;
}

function fakeRunner(runnerId: string): FakeRunner {
  const resumes: RunnerResumeCommand[] = [];
  const answers: string[] = [];
  const sessions = new Map<string, RunnerManagerState>();
  let emitter: ((event: RunnerEvent) => void) | undefined;
  const self: FakeRunner = {
    resumes,
    answers,
    sessions,
    failResume: undefined,
    emit: (event) => emitter?.(event),
    client: fakeRunnerClient({
      runnerId,
      async connect(onEvent) {
        emitter = onEvent;
      },
      async resume(command): Promise<{ cwd: string }> {
        if (self.failResume !== undefined) throw self.failResume.error;
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
      async send() {
        return true;
      },
      async answer(managerId, answer) {
        answers.push(answer.requestId);
        const session = sessions.get(managerId);
        return {
          delivered:
            session !== undefined && session.waiting.some((w) => w.requestId === answer.requestId),
        };
      },
      async stop(managerId) {
        sessions.delete(managerId);
      },
      async list() {
        return [...sessions.values()];
      },
    }),
  };
  return self;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i += 1) await new Promise<void>((r) => setImmediate(r));
}

/** X が確認待ち（ask を出して waiting_human）の委譲を持つ。`leaseAgeMs` は台帳の貸し出しの seenAt の古さ、`holderSeenAgoMs` は名簿が X を最後に聞けてからの時間。 */
async function askingSetup(leaseAgeMs: number, holderSeenAgoMs: number) {
  const stores = createMemoryStores();
  const now = Date.now();
  await stores.jobs.putJob({
    id: 'mgr-1',
    managerId: 'mgr-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running',
    summary: '走行中の委譲',
    request: '続きをやって',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-x',
    lease: {
      runnerId: 'runner-x',
      fence: 4,
      grantedAt: new Date(now - leaseAgeMs - 2_000).toISOString(),
      seenAt: new Date(now - leaseAgeMs).toISOString(),
      ttlMs: 10 * 60_000,
    },
  });
  const x = fakeRunner('runner-x');
  const y = fakeRunner('runner-y');
  const clients = new Map<string, RunnerClient>([
    ['runner-x', x.client],
    ['runner-y', y.client],
  ]);
  const entries = [entryOf('runner-x', 'connected'), entryOf('runner-y', 'connected')];
  for (const entry of entries) {
    if (entry.runnerId === 'runner-x') {
      entry.lastSeenAt = new Date(now - holderSeenAgoMs).toISOString();
    }
  }
  const registry: RunnerRegistry = fakeRunnerRegistry({
    async list() {
      return [...clients.values()];
    },
    async get(runnerId) {
      return clients.get(runnerId) ?? null;
    },
    async select() {
      throw new Error('使わない');
    },
    async register() {},
    async unregister() {},
    vacate() {},
    entries() {
      return entries.map((entry) => ({ ...entry }));
    },
    noteManagerFailed() {},
    subscribe() {
      return () => {};
    },
    async stop() {},
  });
  const sessionOf = (status: 'running' | 'waiting_human'): RunnerManagerState => ({
    liveBackgroundTasks: 0,
    managerId: 'mgr-1',
    status,
    cwd: '/work/project',
    request: '続きをやって',
    waiting:
      status === 'waiting_human'
        ? [
            {
              requestId: 'req-1',
              summary: '本番へ出してよいか',
              kind: 'question',
              askedAt: '2026-10-30T00:00:00.000Z',
            },
          ]
        : [],
    sessionId: 'sess-1',
  });
  x.sessions.set('mgr-1', sessionOf('running'));
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({ stores, post: (e) => inbox.push(e), runners: registry });
  await pool.restore();
  await settle();
  x.sessions.set('mgr-1', sessionOf('waiting_human'));
  x.emit({
    type: 'ask',
    managerId: 'mgr-1',
    requestId: 'req-1',
    kind: 'question',
    summary: '本番へ出してよいか',
  } as RunnerEvent);
  await settle();
  const setState = (runnerId: string, state: RunnerLiveness): void => {
    for (const entry of entries) if (entry.runnerId === runnerId) entry.state = state;
  };
  const setLastSeen = (runnerId: string, agoMs: number): void => {
    for (const entry of entries) {
      if (entry.runnerId === runnerId)
        entry.lastSeenAt = new Date(Date.now() - agoMs).toISOString();
    }
  };
  return { pool, stores, x, y, setState, setLastSeen };
}

async function summaryOf(pool: ManagerPool) {
  const found = (await pool.list()).find((m) => m.managerId === 'mgr-1');
  return {
    status: found?.status,
    live: found?.live,
    sessionMissingSince: found?.sessionMissingSince === undefined ? 'なし' : 'あり',
    sessionMissingKind: found?.sessionMissingKind,
    waiting: found?.waiting.map((w) => w.requestId),
  };
}

describe('M16: 貸し出しが通ったら leaseRefusal の記録が消え、次の断りの日誌が dedupe されない', () => {
  async function decisionsOf(stores: Awaited<ReturnType<typeof askingSetup>>['stores']) {
    const entries = await stores.journal.list({ limit: 100, order: 'asc' });
    return entries.flatMap((entry) => (entry.type === 'decision' ? [entry.decision] : []));
  }

  it('断り → 通る → 再び断られたとき、2 回目の断りも日誌に書く（遷移のときだけ書く dedupe の基準が残らない）', async () => {
    const setup = await askingSetup(11 * 60_000, 2_000);

    // 1 回目: X の名乗りを最近聞けているので断られる（日誌 1 行）。
    setup.setState('runner-x', 'lost');
    setup.pool.relocateFrom('runner-x');
    await settle();
    expect(setup.y.resumes).toHaveLength(0);
    expect(await decisionsOf(setup.stores)).toMatchInlineSnapshot(`
      [
        "[mgr-1] 引き取りを見送った（貸し出しの関門。期限が切れたら自動で挑み直す）",
      ]
    `);

    // 2 回目: X を長く聞けていない → 関門が通り、Y が引き取る（断りの記録はここで消える）。
    setup.setLastSeen('runner-x', 11 * 60_000);
    setup.pool.relocateFrom('runner-x');
    await settle();
    expect(setup.y.resumes).toHaveLength(1);
    expect(await decisionsOf(setup.stores)).toMatchInlineSnapshot(`
      [
        "[mgr-1] 引き取りを見送った（貸し出しの関門。期限が切れたら自動で挑み直す）",
        "[mgr-1] 引き取った（貸し出しを世代 5 で貸し直した。応えているプロセスは未名乗り）",
      ]
    `);

    // 3 回目: こんどは Y が落ちたと見え、X へ移そうとするが、Y に貸したばかりの貸し出しに断られる。直前は通っているので、この断りは日誌に書く。
    setup.x.sessions.clear();
    setup.setState('runner-x', 'connected');
    setup.setLastSeen('runner-x', 1_000);
    setup.setState('runner-y', 'lost');
    setup.setLastSeen('runner-y', 1_000);
    setup.pool.relocateFrom('runner-y');
    await settle();
    expect(setup.x.resumes).toHaveLength(0);
    expect(await decisionsOf(setup.stores)).toMatchInlineSnapshot(`
      [
        "[mgr-1] 引き取りを見送った（貸し出しの関門。期限が切れたら自動で挑み直す）",
        "[mgr-1] 引き取った（貸し出しを世代 5 で貸し直した。応えているプロセスは未名乗り）",
        "[mgr-1] 引き取りを見送った（貸し出しの関門。期限が切れたら自動で挑み直す）",
      ]
    `);

    await setup.pool.stop();
  });
});

describe('M18: 移送は、貸し出しの関門を通った時点で像を「器にセッションが無い」側へ倒す', () => {
  it('前提: ask の後は waiting_human で、確認 req-1 を持つ', async () => {
    const { pool, x, y } = await askingSetup(11 * 60_000, 11 * 60_000);
    expect(await summaryOf(pool)).toMatchInlineSnapshot(`
      {
        "live": true,
        "sessionMissingKind": undefined,
        "sessionMissingSince": "なし",
        "status": "waiting_human",
        "waiting": [
          "req-1",
        ],
      }
    `);
    expect(x.resumes).toHaveLength(0);
    expect(y.resumes).toHaveLength(0);
    await pool.stop();
  });

  it('関門が通って Y へ移った回: 待っていた確認は持ち越されず、status は running になる', async () => {
    const setup = await askingSetup(11 * 60_000, 11 * 60_000);
    setup.setState('runner-x', 'lost');
    setup.pool.relocateFrom('runner-x');
    await settle();
    expect(setup.y.resumes).toHaveLength(1);
    expect(await summaryOf(setup.pool)).toMatchInlineSnapshot(`
      {
        "live": true,
        "sessionMissingKind": undefined,
        "sessionMissingSince": "なし",
        "status": "running",
        "waiting": [],
      }
    `);
    // 持ち越されていれば、以後の回答が死んだ確認への回答として横取りされる。
    const sent = await setup.pool.send('mgr-1', '出してよい', {
      requestId: 'req-1',
      decision: 'allow',
    });
    expect(sent.outcome).not.toBe('answered');
    expect(setup.x.answers).toEqual([]);
    expect(setup.y.answers).toEqual([]);
    await setup.pool.stop();
  });

  it('関門は通ったが Y の resume が 5xx で転んだ回: 像は「器にセッションが無い」側へ倒れ、待っていた確認は消える', async () => {
    const setup = await askingSetup(11 * 60_000, 11 * 60_000);
    setup.y.failResume = { error: new RunnerHttpError('boom', 503) };
    setup.setState('runner-x', 'lost');
    setup.pool.relocateFrom('runner-x');
    await settle();
    expect(setup.y.resumes).toHaveLength(0);
    expect(await summaryOf(setup.pool)).toMatchInlineSnapshot(`
      {
        "live": false,
        "sessionMissingKind": "resume-failed",
        "sessionMissingSince": "あり",
        "status": "waiting_human",
        "waiting": [],
      }
    `);
    await setup.pool.stop();
  });

  it('対照: 関門で断られた回（X の名乗りを最近聞けている）は、倒さず確認も消さない', async () => {
    const setup = await askingSetup(1_000, 1_000);
    setup.setState('runner-x', 'lost');
    setup.pool.relocateFrom('runner-x');
    await settle();
    expect(setup.y.resumes).toHaveLength(0);
    expect(await summaryOf(setup.pool)).toMatchInlineSnapshot(`
      {
        "live": false,
        "sessionMissingKind": undefined,
        "sessionMissingSince": "なし",
        "status": "waiting_human",
        "waiting": [
          "req-1",
        ],
      }
    `);
    await setup.pool.stop();
  });
});

// M21（`#settleStoppedAfterResume` の `restored.end`）と M22（`#issueResume` の失敗時の `restored.end`）は縛っていない:
// `RestoredWindows` の確認の欄（`#confirmations`）は、`begin` が先頭で必ず `end` してから立て直し、`notify` の `#arm` が立てた期限のタイマーだけが
// 外から見える（日誌・知らせ）。この 2 か所の `end` は、窓が開く前（タイマー無し）の欄を消すだけで、消さなくても後続の `begin` / `observe` / `clearConfirmations` が
// 同じ結果になる。外から見える差が出る形は作れなかった（詳細はコミットメッセージ）。

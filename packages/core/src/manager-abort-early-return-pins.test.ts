import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerEntry,
  RunnerEvent,
} from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { InboxEvent, Job } from './schema.js';
import { UnreadableJobError, type Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// `Pool#abort` の早い return のうち、既存の試験が1本も縛っていなかったもの、または文言・副作用までは縛っていなかったものを、
// 外から見える結果（戻り値の outcome / detail 全文・日誌・受信箱への知らせ・台帳の行・runner への命令）だけで縛る。
// 段（非公開メソッド）へ分けるときに早い return や戻り値を取り違えると落ちる。
//   A1a 読めない形の行は「居ない」と言わず unreadable（daemon の `app-routes-managers.ts` で 409 / 404 に分かれる）。何も書かない
//   A1b 台帳に無い委譲は absent。何も書かない
//   A2  宛先の runner が名簿に開いていなければ unknown（absent にしない）。何も書かない
//   A3a 自動の畳み: 止める直前に status が done でなくなっていたら、止めずに not_stopped で取りやめる
//   A3b 自動の畳み: 止める直前に新しい報告（lastReportAt）が入っていたら取りやめる
//   A3c 自動の畳み: status も lastReportAt も動かず、新しい入力の印だけが進んでいたら取りやめる
// 「何も起きない」ことは、結果が出てから setTimeout(0) を2周流して見る（マイクロタスクの数には頼らない）。

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

interface FakeOptions {
  /** 指定すると、`runner.unpushedWork` はこの門が開くまで返らない（abort の最初の往復を止める）。 */
  unpushedGate?: Gate;
  /** true なら `runner.resume` は投げる。 */
  resumeThrows?: boolean;
}

interface Fake {
  client: RunnerClient;
  emit: (event: RunnerEvent) => void;
  stops: string[];
  sends: string[];
  resumes: string[];
}

function fakeRunner(runnerId: string, options: FakeOptions = {}): Fake {
  const holder: { emit?: (event: RunnerEvent) => void } = {};
  const stops: string[] = [];
  const sends: string[] = [];
  const resumes: string[] = [];
  return {
    stops,
    sends,
    resumes,
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
        if (options.resumeThrows === true) throw new Error('resume できない');
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
        stops.push(managerId);
      },
      async list() {
        return [];
      },
      async unpushedWork() {
        if (options.unpushedGate !== undefined) {
          options.unpushedGate.markEntered();
          await options.unpushedGate.opened;
        }
        return { cwd: '/work/project', worktrees: [] };
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
}

function entryOf(runnerId: string): RunnerEntry {
  return {
    label: runnerId,
    state: 'connected',
    runnerId,
    since: '2026-08-01T00:00:00.000Z',
    revision: { status: 'unheard' },
  };
}

interface Env {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  runners: Map<string, Fake>;
}

function build(stores: Stores, runnerIds: string[], options: FakeOptions = {}): Env {
  const runners = new Map(runnerIds.map((id) => [id, fakeRunner(id, options)]));
  const registry = fakeRunnerRegistry({
    async list() {
      return [...runners.values()].map((fake) => fake.client);
    },
    async get(runnerId) {
      return runners.get(runnerId)?.client ?? null;
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
      return runnerIds.map((id) => entryOf(id));
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
    now: () => CLOCK,
  });
  return { pool, stores, inbox, runners };
}

function jobOf(overrides: Partial<Job> = {}): Job {
  return {
    id: 'mgr-1',
    managerId: 'mgr-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'done',
    summary: '手の空いた委譲',
    request: '続きをやって',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-a',
    ...overrides,
  };
}

async function exchangeTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['exchange'] });
  return entries.map((entry) => (entry.type === 'exchange' ? entry.text : ''));
}

async function decisionTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['decision'] });
  return entries.map((entry) => (entry.type === 'decision' ? entry.decision : ''));
}

/** 非同期の続きを macrotask 2周ぶん流しきる（メモリの台帳・日誌は実時間を使わない）。 */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('abort: 居ない・読めない・宛先が開いていない委譲への早い return', () => {
  it('A1a: 読めない形で在る行は「居ない」と言わず、unreadable と理由を全文で返す。何も書かず、何も配らない', async () => {
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      jobs: {
        ...base.jobs,
        getJob: async (id) => {
          if (id === 'mgr-broken') throw new UnreadableJobError({ id, reason: '壊れた行' });
          return base.jobs.getJob(id);
        },
        listUnreadableJobs: async () => [{ id: 'mgr-broken', reason: '壊れた行' }],
      },
    };
    const env = build(stores, ['runner-a']);

    const result = await env.pool.abort('mgr-broken', '止めたい');

    expect(result).toEqual({
      outcome: 'unreadable',
      detail:
        'マネージャー mgr-broken は読めない形で入っている（消されたのでも、畳まれたのでもない）。' +
        '理由: 壊れた行。本文はここでは取れない。止めていない。行は書き換えていない。',
    });
    await drain();
    expect(await exchangeTexts(stores)).toEqual([]);
    expect(env.inbox).toEqual([]);
    expect(env.runners.get('runner-a')?.stops).toEqual([]);
    await env.pool.stop();
  });

  it('A1b: 台帳に無い委譲は absent と全文で返す。何も書かず、何も配らず、runner にも命令しない', async () => {
    const stores = createMemoryStores();
    const env = build(stores, ['runner-a']);

    const result = await env.pool.abort('mgr-nope', '止めたい');

    expect(result).toEqual({
      outcome: 'absent',
      detail: 'mgr-nope というマネージャーは居ない。',
    });
    await drain();
    expect(await exchangeTexts(stores)).toEqual([]);
    expect(env.inbox).toEqual([]);
    expect(env.runners.get('runner-a')?.stops).toEqual([]);
    expect(await env.pool.list()).toEqual([]);
    await env.pool.stop();
  });

  it('A2: 宛先の runner が名簿に開いていなければ、absent と言わず unknown を返す。台帳は書き換えず、何も配らない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobOf({ status: 'running', runnerId: 'runner-gone' }));
    const env = build(stores, ['runner-a']);

    const result = await env.pool.abort('mgr-1', '止めたい');

    expect(result.outcome).toBe('unknown');
    expect(result.detail).toContain('runner-gone');
    expect(result.detail).not.toContain('というマネージャーは居ない');
    expect(Object.keys(result).sort()).toEqual(['detail', 'outcome']);
    await drain();
    expect(await exchangeTexts(stores)).toEqual([]);
    expect(env.inbox).toEqual([]);
    expect(env.runners.get('runner-a')?.stops).toEqual([]);
    expect((await stores.jobs.getJob('mgr-1'))?.status).toBe('running');
    await env.pool.stop();
  });
});

describe('abort: 自動の畳みの、止める直前の読み直しでの早い return', () => {
  const FOLD_DECISION_HEAD = '[auto-fold] mgr-1 の自動の畳みを取りやめた（直前に依頼が入った）: ';

  async function expectCalledOff(env: Env, status: string): Promise<void> {
    const detail =
      'デーモン（pids逼迫の自動畳み）が停止を試みたが、止める直前に mgr-1 へ新しい動きが入っていた' +
      `（status=${status}）ので取りやめた。止めていない。`;
    await vi.waitFor(async () => {
      if ((await decisionTexts(env.stores)).length === 0) throw new Error('日誌がまだ無い');
    });
    await drain();
    expect(await decisionTexts(env.stores)).toEqual([`${FOLD_DECISION_HEAD}${detail}`]);
    // 取りやめた回は「止めた」とも「止めようとした」とも日誌の exchange へ書かず、受信箱へも配らず、runner へも命令しない。
    expect(await exchangeTexts(env.stores)).toEqual([]);
    expect(env.inbox).toEqual([]);
    expect(env.runners.get('runner-a')?.stops).toEqual([]);
  }

  it('A3a: 開始時点で status が done でなければ、止めずに not_stopped と全文で返す（台帳は running のまま）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobOf({ status: 'running' }));
    const env = build(stores, ['runner-a']);

    const result = await env.pool.abort('mgr-1', undefined, 'auto-fold');

    expect(result).toEqual({
      outcome: 'not_stopped',
      detail:
        'デーモン（pids逼迫の自動畳み）が停止を試みたが、止める直前に mgr-1 へ新しい動きが入っていた' +
        '（status=running）ので取りやめた。止めていない。',
    });
    await expectCalledOff(env, 'running');
    expect((await stores.jobs.getJob('mgr-1'))?.status).toBe('running');
    expect((await env.pool.list()).find((m) => m.managerId === 'mgr-1')?.status).toBe('running');
    await env.pool.stop();
  });

  it('A3b: 往復の間に新しい報告が届き lastReportAt が動いたら、status が done のままでも取りやめる', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobOf());
    const unpushedGate = gate();
    const env = build(stores, ['runner-a'], { unpushedGate });
    const fake = env.runners.get('runner-a');

    const aborting = env.pool.abort('mgr-1', undefined, 'auto-fold');
    await unpushedGate.entered;
    fake?.emit({
      type: 'report',
      managerId: 'mgr-1',
      reportId: 'rep-1',
      text: '追加の報告',
      status: 'done',
    });
    await vi.waitFor(async () => {
      if ((await stores.jobs.getJob('mgr-1'))?.lastReportAt === undefined) {
        throw new Error('報告がまだ台帳に載っていない');
      }
    });
    unpushedGate.open();
    const result = await aborting;

    expect(result).toEqual({
      outcome: 'not_stopped',
      detail:
        'デーモン（pids逼迫の自動畳み）が停止を試みたが、止める直前に mgr-1 へ新しい動きが入っていた' +
        '（status=done）ので取りやめた。止めていない。',
    });
    await vi.waitFor(async () => {
      if ((await decisionTexts(stores)).length === 0) throw new Error('日誌がまだ無い');
    });
    await drain();
    expect(await decisionTexts(stores)).toEqual([`${FOLD_DECISION_HEAD}${result.detail}`]);
    // 日誌の exchange は届いた報告の1行だけ（abort は「停止」の行を書いていない）。
    expect(await exchangeTexts(stores)).toEqual(['[応答] [mgr-1] 追加の報告']);
    expect(fake?.stops).toEqual([]);
    expect((await stores.jobs.getJob('mgr-1'))?.status).toBe('done');
    await env.pool.stop();
  });

  it('A3c: status も lastReportAt も動かず、新しい入力の印だけが進んだ回も取りやめる', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobOf());
    const unpushedGate = gate();
    const env = build(stores, ['runner-a'], { unpushedGate, resumeThrows: true });
    const fake = env.runners.get('runner-a');

    const aborting = env.pool.abort('mgr-1', undefined, 'auto-fold');
    await unpushedGate.entered;
    // 渡しに行く前に印を進めるが、resume が投げて台帳は done のまま・報告も無い。
    await expect(env.pool.send('mgr-1', '新しい依頼')).rejects.toThrow('resume できない');
    expect(fake?.resumes).toEqual(['mgr-1']);
    expect((await stores.jobs.getJob('mgr-1'))?.status).toBe('done');
    expect((await stores.jobs.getJob('mgr-1'))?.lastReportAt).toBeUndefined();
    unpushedGate.open();
    const result = await aborting;

    expect(result).toEqual({
      outcome: 'not_stopped',
      detail:
        'デーモン（pids逼迫の自動畳み）が停止を試みたが、止める直前に mgr-1 へ新しい動きが入っていた' +
        '（status=done）ので取りやめた。止めていない。',
    });
    await vi.waitFor(async () => {
      if ((await decisionTexts(stores)).length === 0) throw new Error('日誌がまだ無い');
    });
    await drain();
    // 失敗した resume の引き取りの decision は別に載る。取りやめの decision は1行だけ。
    expect((await decisionTexts(stores)).filter((text) => text.startsWith('[auto-fold]'))).toEqual([
      `${FOLD_DECISION_HEAD}${result.detail}`,
    ]);
    expect(await exchangeTexts(stores)).toEqual([]);
    expect(fake?.stops).toEqual([]);
    await env.pool.stop();
  });
});

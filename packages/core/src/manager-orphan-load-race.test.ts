import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerManagerState,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

const START = '2026-09-01T00:00:00.000Z';

function orphanJob(managerId: string): Job {
  return {
    id: managerId,
    createdAt: START,
    updatedAt: START,
    status: 'lost',
    summary: '調べ物',
    sessionId: 'sess-old',
    runnerId: 'runner-primary',
  };
}

/** 実時間の sleep に頼らず、Promise の解決順だけで順序を作るため。 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** `list()` が常に `[]` を返すので、resume で立ったセッションの畳み直しは測れない（`trackingRunner` で測る）。 */
function neverAliveRunner(runnerId = 'runner-primary'): RunnerClient {
  return {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect() {},
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop() {},
    async list() {
      return [];
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
    async close() {},
  };
}

function trackingRunner(options?: { runnerId?: string; resumeGate?: Promise<void> }): {
  runner: RunnerClient;
  stopCalls: string[];
  resumeCalls: RunnerResumeCommand[];
  sessions: Set<string>;
} {
  const runnerId = options?.runnerId ?? 'runner-primary';
  const sessions = new Set<string>();
  const stopCalls: string[] = [];
  const resumeCalls: RunnerResumeCommand[] = [];

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect() {},
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      resumeCalls.push(command);
      if (options?.resumeGate) await options.resumeGate;
      sessions.add(command.managerId);
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      stopCalls.push(managerId);
      sessions.delete(managerId);
    },
    async list(): Promise<RunnerManagerState[]> {
      return [...sessions].map((id) => ({
        managerId: id,
        status: 'running',
        cwd: '/work/project',
        request: '調べ物',
        waiting: [],
      }));
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
    async close() {},
  };

  return { runner, stopCalls, resumeCalls, sessions };
}

describe('abort() / send() の孤児ジョブ分岐（#load() の二重読み込み、Issue #1703）', () => {
  it('前提: status:lost の委譲は #records に載らない', async () => {
    const managerId = 'mgr-orphan-precondition';
    const stores = createMemoryStores();
    await stores.jobs.putJob(orphanJob(managerId));
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: createRunnerRegistry([neverAliveRunner()]),
      now: () => Date.parse(START),
    });
    await pool.restore();

    const summary = (await pool.list()).find((m) => m.managerId === managerId);
    expect(summary?.status).toBe('lost');
  });

  it('send() と abort() を同時に投げても、台帳には abort() の stopped が残り、send() は delivered を返さない', async () => {
    const managerId = 'mgr-orphan-race';
    const stores = createMemoryStores();
    await stores.jobs.putJob(orphanJob(managerId));

    const { runner, stopCalls, sessions } = trackingRunner();

    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: createRunnerRegistry([runner]),
      now: () => Date.parse(START),
    });
    await pool.restore();

    const [sendResult, abortResult] = await Promise.all([
      pool.send(managerId, 'hello'),
      pool.abort(managerId),
    ]);

    expect(abortResult.outcome).toBe('stopped');
    expect(abortResult.sessionGone).toBe(true);

    expect(sendResult.outcome).not.toBe('delivered');
    expect(sendResult.outcome).toBe('session_missing');

    const finalJob = (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    expect(finalJob?.status).toBe('stopped');

    expect(sessions.has(managerId)).toBe(false);
    // 実行順により stop が1回で足りることも2回になることもある。
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
  });

  it(
    'abort() が resume の前に確定していれば、runner.resume() は1回も呼ばれない' +
      '（チェックポイント1。Promise の解決順だけで順序を作る）',
    async () => {
      const managerId = 'mgr-orphan-precheck';
      const stores = createMemoryStores();
      await stores.jobs.putJob(orphanJob(managerId));

      const { runner, stopCalls, resumeCalls, sessions } = trackingRunner();

      // 数ティック挟むのは、合図の直後に abort() が行う同期区間
      // （record.stopConfirmedAt を立てるところまで）を必ず終わらせるため。
      const abortListCalled = deferred<void>();
      const originalList = runner.list.bind(runner);
      runner.list = async (opts) => {
        const result = await originalList(opts);
        abortListCalled.resolve();
        return result;
      };

      const originalPutJob = stores.jobs.putJob.bind(stores.jobs);
      let armed = false;
      stores.jobs.putJob = async (job) => {
        if (armed) {
          await abortListCalled.promise;
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        }
        return originalPutJob(job);
      };

      const pool = createManagerPool({
        stores,
        post: () => {},
        runners: createRunnerRegistry([runner]),
        now: () => Date.parse(START),
      });
      await pool.restore();
      armed = true;

      const [sendResult, abortResult] = await Promise.all([
        pool.send(managerId, 'hello'),
        pool.abort(managerId),
      ]);

      expect(abortResult.outcome).toBe('stopped');
      expect(abortResult.sessionGone).toBe(true);

      expect(resumeCalls).toHaveLength(0);
      expect(stopCalls).toHaveLength(1);
      expect(sessions.has(managerId)).toBe(false);

      expect(sendResult.outcome).not.toBe('delivered');
      expect(sendResult.outcome).toBe('session_missing');

      const finalJob = (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
      expect(finalJob?.status).toBe('stopped');
    },
  );

  it(
    'resume の途中で abort() が確定すると、起こしてしまったセッションを畳み直す' +
      '（チェックポイント2/3。Promise の解決順だけで順序を作る）',
    async () => {
      const managerId = 'mgr-orphan-midcheck';
      const stores = createMemoryStores();
      await stores.jobs.putJob(orphanJob(managerId));

      // stopConfirmedAt は runner.stop() / list() を待たずに立つので、チェックポイント1が
      // 先に捕まえることもある。どちらが捕まえても結果は同じなので resumeCalls の本数で分岐する。
      const abortListCalled = deferred<void>();
      const { runner, stopCalls, resumeCalls, sessions } = trackingRunner({
        resumeGate: (async () => {
          await abortListCalled.promise;
          await Promise.resolve();
          await Promise.resolve();
        })(),
      });
      const originalList = runner.list.bind(runner);
      runner.list = async (opts) => {
        const result = await originalList(opts);
        abortListCalled.resolve();
        return result;
      };

      const pool = createManagerPool({
        stores,
        post: () => {},
        runners: createRunnerRegistry([runner]),
        now: () => Date.parse(START),
      });
      await pool.restore();

      const [sendResult, abortResult] = await Promise.all([
        pool.send(managerId, 'hello'),
        pool.abort(managerId),
      ]);

      expect(abortResult.outcome).toBe('stopped');
      expect(abortResult.sessionGone).toBe(true);

      expect(sessions.has(managerId)).toBe(false);
      if (resumeCalls.length === 0) {
        expect(stopCalls).toHaveLength(1);
      } else {
        expect(resumeCalls).toHaveLength(1);
        expect(stopCalls).toHaveLength(2);
      }

      expect(sendResult.outcome).not.toBe('delivered');
      expect(sendResult.outcome).toBe('session_missing');

      const finalJob = (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
      expect(finalJob?.status).toBe('stopped');
    },
  );

  it('abort() が not_stopped を返した後は、印（stopConfirmedAt）が下ろされ、send() は従来どおり進む', async () => {
    const managerId = 'mgr-orphan-not-stopped';
    const stores = createMemoryStores();
    await stores.jobs.putJob(orphanJob(managerId));

    const runner: RunnerClient = {
      runnerId: 'runner-primary',
      runnerIdKnown: true,
      workspacePath: '/work/project',
      workspacePathKnown: true,
      async connect() {},
      async start(): Promise<{ cwd?: string }> {
        return {};
      },
      async resume(): Promise<{ cwd?: string }> {
        return {};
      },
      async send() {
        return true;
      },
      async answer(): Promise<RunnerAnswerOutcome> {
        return { delivered: false };
      },
      async stop() {
        // 何もしない（止まらない、を模す）。
      },
      async list(): Promise<RunnerManagerState[]> {
        return [
          {
            managerId,
            status: 'running',
            cwd: '/work/project',
            request: '調べ物',
            waiting: [],
          },
        ];
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
      async close() {},
    };

    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: createRunnerRegistry([runner]),
      now: () => Date.parse(START),
    });
    await pool.restore();

    // Promise.all で同時に投げない: 印を下ろす前に send() 側が印を見て session_missing を返しうるので、
    // 「印が下ろされた後」を測るには abort() を先に終わらせる必要がある。
    const abortResult = await pool.abort(managerId);
    expect(abortResult.outcome).toBe('not_stopped');
    expect(abortResult.sessionGone).toBe(false);

    const sendResult = await pool.send(managerId, 'hello');
    expect(sendResult.outcome).toBe('delivered');

    const finalJob = (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    expect(finalJob?.status).toBe('running');
  });

  // `send()` 経由ではチェックポイント3（台帳へ書く直前）が肩代わりするので、チェックポイント2の要否は独立に測れない。
  // `#reattach()` は 'resumed' の後に `lost` かどうかしか見ず、チェックポイント3に当たるものが無いので、ここではその経路を直接確かめる。
  it('#reattach() が resume の途中で abort() が確定しても running を書き戻さない（チェックポイント2）', async () => {
    const managerId = 'mgr-reattach-race';
    const stores = createMemoryStores();
    const job: Job = {
      id: managerId,
      createdAt: START,
      updatedAt: START,
      status: 'running',
      summary: '走っていた仕事',
      request: '走っていた仕事の依頼',
      cwd: '/work/project',
      sessionId: 'sess-1',
      runnerId: 'runner-primary',
    };
    await stores.jobs.putJob(job);

    const sessions = new Set<string>();
    const stopCalls: string[] = [];
    const resumeCalls: RunnerResumeCommand[] = [];
    // ティック数を数えない: #reattach は send() より短い経路で resume に達し、数ティックでは abort() の
    // 同期区間に追いつけないので、abort() が返す Promise そのものを待つ。
    // `let` ではなく箱に入れる: 束縛は再代入せず、中身だけを後で埋める。
    const abortSettled: { promise?: Promise<unknown> } = {};

    const runner: RunnerClient = {
      runnerId: 'runner-primary',
      runnerIdKnown: true,
      workspacePath: '/work/project',
      workspacePathKnown: true,
      async connect() {},
      async start(): Promise<{ cwd?: string }> {
        return {};
      },
      async resume(command): Promise<{ cwd?: string }> {
        resumeCalls.push(command);
        await abortSettled.promise;
        sessions.add(command.managerId);
        return {};
      },
      async send() {
        return true;
      },
      async answer(): Promise<RunnerAnswerOutcome> {
        return { delivered: false };
      },
      async stop(id) {
        stopCalls.push(id);
        sessions.delete(id);
      },
      async list(): Promise<RunnerManagerState[]> {
        return [...sessions].map((id) => ({
          managerId: id,
          status: 'running' as const,
          cwd: '/work/project',
          request: '調べ物',
          waiting: [],
        }));
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
      async close() {},
    };

    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: registry,
      now: () => Date.parse(START),
    });

    const reattachPromise = pool.reattachRunner('runner-primary');
    const abortPromise = pool.abort(managerId);
    abortSettled.promise = abortPromise;
    const [, abortResult] = await Promise.all([reattachPromise, abortPromise]);

    expect(abortResult.outcome).toBe('stopped');
    expect(abortResult.sessionGone).toBe(true);

    expect(sessions.has(managerId)).toBe(false);
    // チェックポイント1が先に捕まえることもあるので resumeCalls の本数で分岐する。
    if (resumeCalls.length === 0) {
      expect(stopCalls).toHaveLength(1);
    } else {
      expect(resumeCalls).toHaveLength(1);
      expect(stopCalls).toHaveLength(2);
    }

    const finalJob = (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    expect(finalJob?.status).toBe('stopped');
  });
});

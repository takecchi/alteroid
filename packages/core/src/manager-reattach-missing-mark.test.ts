import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import { RunnerHttpError } from './runner-protocol.js';
import type { RunnerClient, RunnerEntry, RunnerManagerState } from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { Job, JobLease } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 同じ runner の取り直し（`#reattachOne`、移送でない回）が、「resume でも入り直せなかった」（`sessionMissingKind: 'resume-failed'`）の印を、
// 貸し出しの関門を通って実際に resume を挑み、転んだ回にだけ立てることを縛る。
// 関門（held / persist-failed / ambiguous）が断った回は resume を呼んでいない。印を立てると、前の器が握っているだけの `held` を「セッション無し」と読ませる。
// 実時間は使わない（fake timer の有界の前進）。`attached` は `list()` に出ないので、ここでは縛らない（`manager-reattach-state-pins.test.ts` 側）。

const CLOCK = Date.parse('2026-09-01T00:00:00.000Z');

function entryOf(overrides: Partial<RunnerEntry> = {}): RunnerEntry {
  return {
    label: 'runner-a',
    state: 'connected',
    runnerId: 'runner-a',
    since: '2026-08-01T00:00:00.000Z',
    revision: { status: 'unheard' },
    ...overrides,
  };
}

function jobOf(lease: JobLease): Job {
  return {
    id: 'mgr-1',
    managerId: 'mgr-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running',
    summary: '走行中の委譲',
    request: '続きをやって',
    cwd: '/work/project',
    sessionId: 'sess-mgr-1',
    runnerId: 'runner-a',
    lease,
  };
}

/** 前の器（boot-1）が握っていて、まだ期限の内。 */
const HELD: JobLease = {
  runnerId: 'runner-a',
  instanceId: 'boot-1',
  fence: 4,
  grantedAt: new Date(CLOCK - 2_000).toISOString(),
  seenAt: new Date(CLOCK - 1_000).toISOString(),
  ttlMs: 10 * 60_000,
};

/** 前の器が握っていたが、期限が切れている（関門は通る）。 */
const EXPIRED: JobLease = {
  ...HELD,
  grantedAt: new Date(CLOCK - 2 * 3_600_000).toISOString(),
  seenAt: new Date(CLOCK - 3_600_000).toISOString(),
  ttlMs: 1_000,
};

interface Env {
  pool: ManagerPool;
  resumes: string[];
  /** 返した値を投げる（`undefined` なら通す）。 */
  failResume: { error: unknown } | undefined;
  breakWrites: { error: string } | undefined;
}

async function build(job: Job, entries: RunnerEntry[]) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(CLOCK);
  const sessions = new Map<string, RunnerManagerState>();
  const env: Env = {
    pool: undefined as unknown as ManagerPool,
    resumes: [],
    failResume: undefined,
    breakWrites: undefined,
  };
  const client: RunnerClient = fakeRunnerClient({
    runnerId: 'runner-a',
    async resume(command) {
      if (env.failResume !== undefined) throw env.failResume.error;
      env.resumes.push(command.managerId);
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
    async list() {
      return [...sessions.values()];
    },
  });
  const base = createMemoryStores();
  await base.jobs.putJob(job);
  const stores: Stores = {
    ...base,
    jobs: {
      ...base.jobs,
      putJob: async (next) => {
        if (env.breakWrites !== undefined) throw new Error(env.breakWrites.error);
        await base.jobs.putJob(next);
      },
    },
  };
  const registry = fakeRunnerRegistry({
    async list() {
      return [client];
    },
    async get(runnerId) {
      return runnerId === 'runner-a' ? client : null;
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
  env.pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    now: () => Date.now(),
  });
  return env;
}

async function markOf(pool: ManagerPool) {
  const found = (await pool.list()).find((m) => m.managerId === 'mgr-1');
  return {
    since: found?.sessionMissingSince === undefined ? 'なし' : 'あり',
    kind: found?.sessionMissingKind,
  };
}

const NO_MARK = { since: 'なし', kind: undefined };
const RESUME_FAILED = { since: 'あり', kind: 'resume-failed' };

afterEach(() => {
  vi.useRealTimers();
});

describe('同じ runner の取り直し: 「resume でも入り直せなかった」の印は、関門を通って resume を挑んで転んだ回にだけ立つ', () => {
  it('held: 前の器の貸し出しが生きていて関門が断った回は、印を立てない（resume は撃たれていない）', async () => {
    const env = await build(jobOf(HELD), [
      entryOf({ instanceId: 'boot-2', instanceSince: new Date(CLOCK).toISOString() }),
    ]);
    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(env.resumes).toEqual([]);
    expect(await markOf(env.pool)).toEqual(NO_MARK);
    await env.pool.stop();
  });

  it('persist-failed: 貸し出しを台帳へ書けず関門が断った回は、印を立てない', async () => {
    const env = await build(jobOf(EXPIRED), [
      entryOf({ instanceId: 'boot-2', instanceSince: new Date(CLOCK - 3_600_000).toISOString() }),
    ]);
    env.breakWrites = { error: '台帳に書けない' };
    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(env.resumes).toEqual([]);
    expect(await markOf(env.pool)).toEqual(NO_MARK);
    await env.pool.stop();
  });

  it('ambiguous: 同じ runnerId が併存していて関門が断った回は、印を立てない', async () => {
    const env = await build(jobOf(EXPIRED), [
      entryOf({ label: 'runner-a-1', instanceId: 'boot-2' }),
      entryOf({ label: 'runner-a-2', instanceId: 'boot-3' }),
    ]);
    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(env.resumes).toEqual([]);
    expect(await markOf(env.pool)).toEqual(NO_MARK);
    await env.pool.stop();
  });

  it('対照: 関門を通って resume を挑み、転んだ回は resume-failed の印が立つ', async () => {
    const env = await build(jobOf(EXPIRED), [
      entryOf({ instanceId: 'boot-2', instanceSince: new Date(CLOCK - 3_600_000).toISOString() }),
    ]);
    env.failResume = { error: new RunnerHttpError('boom', 503) };
    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(env.resumes).toEqual([]);
    expect(await markOf(env.pool)).toEqual(RESUME_FAILED);
    await env.pool.stop();
  });

  it('対照: 関門を通って resume が成功した回は、印が立たない', async () => {
    const env = await build(jobOf(EXPIRED), [
      entryOf({ instanceId: 'boot-2', instanceSince: new Date(CLOCK - 3_600_000).toISOString() }),
    ]);
    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(env.resumes).toEqual(['mgr-1']);
    expect(await markOf(env.pool)).toEqual(NO_MARK);
    await env.pool.stop();
  });

  it('対照: 転んで印が立っていた委譲が、次の挑み直しで resume に成功すると印が下りる', async () => {
    const env = await build(jobOf(EXPIRED), [
      entryOf({ instanceId: 'boot-2', instanceSince: new Date(CLOCK - 3_600_000).toISOString() }),
    ]);
    env.failResume = { error: new RunnerHttpError('boom', 503) };
    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(500);
    expect(await markOf(env.pool)).toEqual(RESUME_FAILED);
    env.failResume = undefined;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(env.resumes).toEqual(['mgr-1']);
    expect(await markOf(env.pool)).toEqual(NO_MARK);
    await env.pool.stop();
  });

  it('対照: 断られて印が無かった委譲が、次の挑み直しで関門を通って転ぶと、その回に印が立つ', async () => {
    const entries = [
      entryOf({ instanceId: 'boot-2', instanceSince: new Date(CLOCK).toISOString() }),
    ];
    const env = await build(jobOf(HELD), entries);
    await env.pool.reattachRunner('runner-a');
    await vi.advanceTimersByTimeAsync(500);
    expect(await markOf(env.pool)).toEqual(NO_MARK);
    env.failResume = { error: new RunnerHttpError('boom', 503) };
    // 貸し出しの期限（10 分）と猶予を過ぎるまで梯子（30 秒間隔で頭打ち）を回す。
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(env.resumes).toEqual([]);
    expect(await markOf(env.pool)).toEqual(RESUME_FAILED);
    await env.pool.stop();
  });
});

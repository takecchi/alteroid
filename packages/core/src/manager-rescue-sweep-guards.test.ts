import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerClient,
  type RunnerManagerState,
  type RunnerRescueRefDeleteRequest,
  type RunnerRescueRefDeleteResult,
} from './runner-protocol.js';
import type { Job, RescueWorktree } from './schema.js';
import { createMemoryStores } from './testing.js';

// 退避 ref の掃除（`sweepRescueRefs`）の守りを、公開の口だけで縛る。掃除を別のクラスへ切り出しても同じ試験が通ること。
const DAY = 24 * 60 * 60_000;
const MIN = 60_000;
let nowMs = Date.parse('2026-10-20T00:00:00.000Z');
const iso = (offset: number): string => new Date(nowMs + offset).toISOString();

const REMOTE = 'https://github.com/o/r.git';
const COMMIT = 'a'.repeat(40);
const refOf = (id: string): string => `refs/alteroid-rescue/${id}/root-1234abcd`;

function tree(id: string): RescueWorktree {
  return {
    relativePath: '.',
    branch: 'main',
    at: iso(-30 * DAY),
    pushed: { ref: refOf(id), commit: COMMIT, at: iso(-30 * DAY), remote: REMOTE },
  };
}

function jobOf(
  id: string,
  status: Job['status'],
  quietDays: number,
  extra: Partial<Job> = {},
): Job {
  const terminal =
    status === 'done' || status === 'failed' || status === 'stopped'
      ? { terminal: { status, seenAt: iso(-quietDays * DAY) } }
      : {};
  return {
    id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: iso(0),
    status,
    summary: '調べ物',
    request: 'r',
    cwd: '/work/project',
    sessionId: `sess-${id}`,
    runnerId: 'runner-primary',
    lastRescue: { at: iso(-quietDays * DAY), worktrees: [tree(id)], ...terminal },
    ...extra,
  };
}

interface Fake {
  runner: RunnerClient;
  calls: RunnerRescueRefDeleteRequest[];
  /** 削除の呼び出しごとに走る。返すまで `deleteRescueRef` は返らない。 */
  onDelete: { run: (request: RunnerRescueRefDeleteRequest) => Promise<void> };
}

function fakeRunner(alive: RunnerManagerState[] = []): Fake {
  const calls: RunnerRescueRefDeleteRequest[] = [];
  const onDelete: Fake['onDelete'] = { run: async () => undefined };
  const result: RunnerRescueRefDeleteResult = { outcome: 'removed', alreadyGone: false };
  const runner = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect() {
      /* 使わない */
    },
    async list() {
      return [...alive];
    },
    async stop(managerId: string) {
      const index = alive.findIndex((state) => state.managerId === managerId);
      if (index >= 0) alive.splice(index, 1);
    },
    async close() {
      /* 使わない */
    },
    async deleteRescueRef(request: RunnerRescueRefDeleteRequest) {
      calls.push(request);
      await onDelete.run(request);
      return result;
    },
  } as unknown as RunnerClient;
  return { runner, calls, onDelete };
}

function aliveOf(id: string): RunnerManagerState {
  return {
    liveBackgroundTasks: 0,
    managerId: id,
    status: 'running',
    cwd: '/work/project',
    request: 'r',
    waiting: [],
    sessionId: `sess-${id}`,
  };
}

async function setup(jobs: Job[], fake: Fake = fakeRunner(), restore = false) {
  const stores = createMemoryStores();
  for (const job of jobs) await stores.jobs.putJob(job);
  const pool: ManagerPool = createManagerPool({
    stores,
    post: () => undefined,
    runners: createRunnerRegistry([fake.runner]),
    now: () => nowMs,
  });
  if (restore) await pool.restore();
  const jobOfId = async (id: string) =>
    (await stores.jobs.listJobs()).find((j) => j.id === id) as Job;
  return { pool, stores, fake, jobOfId };
}

describe('退避 ref の掃除の守り（切り出しで崩れうる振る舞い）', () => {
  it('掃除の最中に来た2本目の sweepRescueRefs は、掃除を重ねずにすぐ返る', async () => {
    const fake = fakeRunner();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.onDelete.run = () => gate;
    const { pool, jobOfId } = await setup([jobOf('mgr-a', 'done', 8)], fake);

    const first = pool.sweepRescueRefs?.();
    for (let i = 0; i < 200 && fake.calls.length === 0; i += 1) await Promise.resolve();
    expect(fake.calls).toHaveLength(1);

    // 1本目は削除の返りを待っている。2本目は gate を開けなくても返る
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toHaveLength(1);

    release();
    await first;
    expect(fake.calls).toHaveLength(1);
    expect((await jobOfId('mgr-a')).lastRescue?.worktrees[0]?.pushed?.removal?.reason).toBe('done');
    await pool.stop();
  });

  it('掃除が終われば欄は戻り、周期を過ぎた次の掃除は走る（掃除中の印が残らない）', async () => {
    const fake = fakeRunner();
    const { pool, stores } = await setup([jobOf('mgr-a', 'done', 8)], fake);
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toHaveLength(1);
    await stores.jobs.putJob(jobOf('mgr-b', 'done', 8));
    nowMs += 11 * MIN;
    await pool.sweepRescueRefs?.();
    expect(fake.calls.map((c) => c.ref)).toEqual([refOf('mgr-a'), refOf('mgr-b')]);
    await pool.stop();
  });

  it('周期（10分）の内の2回目は掃除しない。過ぎれば掃除する', async () => {
    const fake = fakeRunner();
    const { pool, stores } = await setup([jobOf('mgr-a', 'done', 1)], fake);
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toEqual([]);
    // 1回目のあとに、撃つべき委譲が台帳へ入った
    await stores.jobs.putJob(jobOf('mgr-b', 'done', 8));
    nowMs += 9 * MIN;
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toEqual([]);
    nowMs += 1 * MIN;
    await pool.sweepRescueRefs?.();
    expect(fake.calls.map((c) => c.ref)).toEqual([refOf('mgr-b')]);
    await pool.stop();
  });

  it('台帳を読めなかった回は周期を進めない（次の呼び出しがすぐ掃除する）', async () => {
    const fake = fakeRunner();
    const { pool, stores } = await setup([jobOf('mgr-a', 'done', 8)], fake);
    const original = stores.jobs.listJobs.bind(stores.jobs);
    let failing = true;
    stores.jobs.listJobs = async () => {
      if (failing) throw new Error('db down');
      return original();
    };
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toEqual([]);
    failing = false;
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toHaveLength(1);
    await pool.stop();
  });

  it('像の在る委譲は像を更新して台帳へ書き戻し、像の無い委譲は台帳だけを更新する（どちらも lastRescue の古い終端の印が外れる）', async () => {
    // running なのに終端の印が残っている lastRescue: 掃除は印を外す
    const stale = (id: string, extra: Partial<Job> = {}): Job => ({
      ...jobOf(id, 'running', 1, extra),
      lastRescue: {
        at: iso(-DAY),
        worktrees: [tree(id)],
        terminal: { status: 'done', seenAt: iso(-DAY) },
      },
    });
    const edit = (current: Job): Job => ({ ...current, summary: '台帳で書き換えた' });

    // 像の在る側（restore で像ができる）: 台帳が先に書き換わっていても像が正で、書き戻しで台帳が像へ戻る
    const liveFake = fakeRunner([aliveOf('mgr-live')]);
    const live = await setup([stale('mgr-live')], liveFake, true);
    await live.stores.jobs.updateJob('mgr-live', edit);
    await live.pool.sweepRescueRefs?.();
    const liveJob = await live.jobOfId('mgr-live');
    expect(liveJob.lastRescue?.terminal).toBeUndefined();
    expect(liveJob.lastRescue?.at).toBe(iso(-DAY));
    expect(liveJob.summary).toBe('調べ物');
    expect(liveFake.calls).toEqual([]);
    await live.pool.stop();

    // 像の無い側（restore しない）: 台帳を読み直して書くので、台帳の書き換えが残る
    const ledgerFake = fakeRunner();
    const ledger = await setup([stale('mgr-ledger')], ledgerFake);
    await ledger.stores.jobs.updateJob('mgr-ledger', edit);
    await ledger.pool.sweepRescueRefs?.();
    const ledgerJob = await ledger.jobOfId('mgr-ledger');
    expect(ledgerJob.lastRescue?.terminal).toBeUndefined();
    expect(ledgerJob.lastRescue?.at).toBe(iso(-DAY));
    expect(ledgerJob.summary).toBe('台帳で書き換えた');
    expect(ledgerFake.calls).toEqual([]);
    await ledger.pool.stop();
  });

  it('止めて像が外れた後も、掃除は台帳から終端を印し、周期の欄は担当の入れ替わりで動かない', async () => {
    const fake = fakeRunner([aliveOf('mgr-live')]);
    const { pool, jobOfId } = await setup(
      [
        {
          ...jobOf('mgr-live', 'running', 20),
          lastRescue: { at: iso(-20 * DAY), worktrees: [tree('mgr-live')] },
        },
      ],
      fake,
      true,
    );
    // 像の在るうちに1回掃除する（周期の起点。running なので何も書かない）
    await pool.sweepRescueRefs?.();
    expect((await jobOfId('mgr-live')).lastRescue?.terminal).toBeUndefined();

    const aborted = await pool.abort('mgr-live', 'テスト');
    expect(aborted.outcome).toBe('stopped');

    // 像は外れた。周期の内なので掃除しない（外れたことで周期が巻き戻らない）
    nowMs += 5 * MIN;
    await pool.sweepRescueRefs?.();
    expect((await jobOfId('mgr-live')).lastRescue?.terminal).toBeUndefined();

    // 周期を過ぎれば、像が無くても台帳から終端を初めて見た時刻を印す。猶予の手前なので撃たない
    nowMs += 6 * MIN;
    await pool.sweepRescueRefs?.();
    expect((await jobOfId('mgr-live')).lastRescue?.terminal).toEqual({
      status: 'stopped',
      seenAt: iso(0),
    });
    expect(fake.calls).toEqual([]);

    // 猶予（stopped は14日）を過ぎれば、像が無いまま台帳へ removal を書いて撃つ
    nowMs += 14 * DAY;
    await pool.sweepRescueRefs?.();
    expect(fake.calls.map((c) => c.ref)).toEqual([refOf('mgr-live')]);
    expect((await jobOfId('mgr-live')).lastRescue?.worktrees[0]?.pushed?.removal?.reason).toBe(
      'stopped',
    );
    await pool.stop();
  });

  it('掃除の途中で stop() が呼ばれたら、残りの委譲は撃たず、止めた後の掃除も走らない', async () => {
    const fake = fakeRunner();
    const ids = ['mgr-1', 'mgr-2', 'mgr-3'];
    const { pool, jobOfId } = await setup(
      ids.map((id) => jobOf(id, 'done', 8)),
      fake,
    );
    fake.onDelete.run = async () => {
      if (fake.calls.length === 1) await pool.stop();
    };
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toHaveLength(1);
    expect((await jobOfId('mgr-2')).lastRescue?.worktrees[0]?.pushed?.removal).toBeUndefined();
    expect((await jobOfId('mgr-3')).lastRescue?.worktrees[0]?.pushed?.removal).toBeUndefined();

    nowMs += 11 * MIN;
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toHaveLength(1);
  });
});

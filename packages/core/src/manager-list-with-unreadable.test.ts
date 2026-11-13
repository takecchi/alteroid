import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// `ManagerPool.listWithUnreadable()`: 地図の build が台帳を 1 回の scan で読むための口。
// 結果は `list()` と `listUnreadableJobs()` を別々に呼んだものと同じで、`list()` が書く計器も同じ条件・回数で通る。

const UNREADABLE = [{ id: 'mgr-bad', reason: '不正な欄: status' }];

function countingStores(): { stores: Stores; calls: string[] } {
  const stores = createMemoryStores();
  const calls: string[] = [];
  const base = stores.jobs;
  stores.jobs = {
    ...base,
    listJobs: async () => {
      calls.push('listJobs');
      return base.listJobs();
    },
    listUnreadableJobs: async () => {
      calls.push('listUnreadableJobs');
      return UNREADABLE;
    },
    listJobsWithUnreadable: async () => {
      calls.push('listJobsWithUnreadable');
      return { jobs: await base.listJobs(), unreadable: UNREADABLE };
    },
  };
  return { stores, calls };
}

async function seedRunning(stores: Stores, id: string, runnerId: string): Promise<void> {
  const createdAt = '2026-09-24T00:00:00.000Z';
  await stores.jobs.putJob({
    id,
    managerId: id,
    createdAt,
    updatedAt: createdAt,
    status: 'running',
    summary: '仕事',
    request: '仕事',
    cwd: '/work/project',
    runnerId,
    sessionId: `sess-${id}`,
  });
}

async function gaugeLines(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ order: 'asc' });
  return entries
    .map((entry) => (entry as { text?: string }).text ?? '')
    .filter((text) => text.includes('名簿から entry ごと消えている'));
}

async function setup() {
  const { stores, calls } = countingStores();
  await seedRunning(stores, 'mgr-ok', 'runner-gone');
  await seedRunning(stores, 'mgr-ok2', 'runner-gone');
  // runner を登録しない: 名簿から entry ごと消えた形で、計器が立つ
  const registry = createRunnerRegistry([]);
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    now: () => Date.parse('2026-09-24T01:05:00.000Z'),
  });
  calls.length = 0;
  return {
    stores,
    calls,
    pool,
    done: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

describe('ManagerPool.listWithUnreadable()', () => {
  it('managers は list() と同じ、unreadable は listUnreadableJobs() と同じ', async () => {
    const a = await setup();
    const b = await setup();

    const separate = {
      managers: await a.pool.list(),
      unreadable: await a.stores.jobs.listUnreadableJobs(),
    };
    const combined = await b.pool.listWithUnreadable();

    expect(combined.unreadable).toEqual(UNREADABLE);
    expect(combined).toEqual(separate);
    expect(combined.managers.map((m) => m.managerId).sort()).toEqual(['mgr-ok', 'mgr-ok2']);

    await a.done();
    await b.done();
  });

  it('台帳の scan は listJobsWithUnreadable() の 1 回だけ（listJobs / listUnreadableJobs は呼ばない）', async () => {
    const s = await setup();
    await s.pool.listWithUnreadable();
    expect(s.calls).toEqual(['listJobsWithUnreadable']);
    await s.done();
  });

  it('list() は従来どおり listJobs() の 1 回だけ', async () => {
    const s = await setup();
    await s.pool.list();
    expect(s.calls).toEqual(['listJobs']);
    await s.done();
  });

  it('計器: list() 1 回と listWithUnreadable() 1 回で、同じ観測が 1 回ずつ', async () => {
    const a = await setup();
    const b = await setup();

    await a.pool.list();
    await b.pool.listWithUnreadable();

    const viaList = await gaugeLines(a.stores);
    const viaNew = await gaugeLines(b.stores);
    expect(viaList).toHaveLength(1);
    expect(viaNew).toEqual(viaList);

    await a.done();
    await b.done();
  });

  it('計器の書く頻度は両方の口で共有する: 重ねて呼んでも、混ぜて呼んでも、本数が同じなら 1 行', async () => {
    const s = await setup();
    await s.pool.listWithUnreadable();
    await s.pool.listWithUnreadable();
    await s.pool.list();
    await s.pool.listWithUnreadable();
    expect(await gaugeLines(s.stores)).toHaveLength(1);
    await s.done();
  });

  it('計器が投げても listWithUnreadable() は例外を投げず同じ結果を返す', async () => {
    const { stores } = countingStores();
    await seedRunning(stores, 'mgr-ok', 'runner-gone');
    const registry = createRunnerRegistry([]);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => {
        throw new Error('clock down');
      },
    });

    const result = await pool.listWithUnreadable();

    expect(result.managers.map((m) => m.managerId)).toEqual(['mgr-ok']);
    expect(result.unreadable).toEqual(UNREADABLE);

    await pool.stop();
    await registry.stop();
  });
});

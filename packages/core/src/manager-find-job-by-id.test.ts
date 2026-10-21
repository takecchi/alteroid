import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import type { RunnerRegistry } from './runner-protocol.js';
import type { Job } from './schema.js';
import { UnreadableJobError } from './store.js';
import { createMemoryStores } from './testing.js';

// 1件のために台帳を全部読まない（#5140）: `listJobs()` は全行の版を読むので、1件を探す経路は主キーで1行を読む `getJob` を通る

const registry: RunnerRegistry = {
  async list() {
    return [];
  },
  async get() {
    return null;
  },
  async select() {
    throw new Error('この試験では使わない');
  },
  async register() {},
  async unregister() {},
  vacate() {},
  entries() {
    return [];
  },
  noteManagerFailed() {},
  subscribe() {
    return () => {};
  },
  async stop() {},
};

function jobOf(id: string, runnerId: string): Job {
  return {
    id,
    managerId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'done',
    summary: '終わった委譲',
    request: 'やって',
    cwd: '/work/project',
    sessionId: `sess-${id}`,
    lastReport: '済んだ',
    runnerId,
  };
}

function harness(options: { unreadable?: string } = {}) {
  const base = createMemoryStores();
  let listJobsCalls = 0;
  const stores: ReturnType<typeof createMemoryStores> = {
    ...base,
    jobs: {
      ...base.jobs,
      listJobs: async () => {
        listJobsCalls += 1;
        return base.jobs.listJobs();
      },
      getJob: async (id) => {
        if (id === options.unreadable) throw new UnreadableJobError({ id, reason: '壊れた行' });
        return base.jobs.getJob(id);
      },
    },
  };
  const pool = createManagerPool({ stores, post: () => {}, runners: registry });
  return { base, pool, listJobsCalls: () => listJobsCalls };
}

describe('1件の委譲を引く経路は、台帳を全部読まない（#5140）', () => {
  it('⭐ 像に無い委譲の runner を、台帳を全部読まずに主キーの1行から答える', async () => {
    const h = harness();
    await h.base.jobs.putJob(jobOf('mgr-old', 'runner-7'));
    const before = h.listJobsCalls();

    expect(await h.pool.runnerIdOf('mgr-old')).toBe('runner-7');
    expect(h.listJobsCalls()).toBe(before);
  });

  it('台帳に無い委譲は、今までどおり見つからない', async () => {
    const h = harness();
    expect(await h.pool.runnerIdOf('mgr-none')).toBeUndefined();
  });

  it('読めない形で入っている行は、今までどおり見つからない扱いにする（投げない）', async () => {
    const h = harness({ unreadable: 'mgr-broken' });
    await h.base.jobs.putJob(jobOf('mgr-broken', 'runner-7'));
    expect(await h.pool.runnerIdOf('mgr-broken')).toBeUndefined();
  });
});

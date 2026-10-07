import type { Job } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { jobs } from './schema.js';
import { createMigratedTestDb } from './test-db.test-support.js';

let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

describe('JobStore.clear() — 壊れた行も件数に数える（pg 実装、issue #1892）', () => {
  const GOOD_JOB: Job = {
    id: 'mgr-good',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'done',
    summary: '正常な job',
  };

  it('正しい行1件と status の壊れた行1件を置くと、listJobs() は1件・clear() は2件を返す', async () => {
    await stores.jobs.putJob(GOOD_JOB);
    await db.insert(jobs).values({
      id: 'mgr-bad',
      status: 'not-a-real-status-from-a-newer-deploy',
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
      job: {
        id: 'mgr-bad',
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
        status: 'not-a-real-status-from-a-newer-deploy',
        summary: '壊れた job',
      },
    });

    expect((await stores.jobs.listJobs()).map((job) => job.id)).toEqual(['mgr-good']);
    expect(await stores.jobs.clear()).toEqual({ jobs: 2, approvals: 0 });
    expect(await db.select().from(jobs)).toEqual([]);
  });
});

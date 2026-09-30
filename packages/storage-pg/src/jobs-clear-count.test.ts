import type { Job } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { jobs } from './schema.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * issue #1892。`JobStore.clear()` が返す件数は、**行の中身が壊れているかに
 * 関係なく、消した行すべて**を数える——ここは pg 実装がその形であることを
 * 押さえる対の歯である（fs 側は
 * `packages/storage-fs/src/jobs-malformed-row-repro.test.ts` の
 * `clear() は正しい行も壊れた行も両方消す`）。fs が正しい行だけを数えていた
 * ため、同じ状態で呼ぶと fs は `{ jobs: 1 }`、pg は `{ jobs: 2 }` を返して
 * いた。どちらかが黙って動いたときに、片側だけ緑のまま食い違いが戻らない
 * よう、両方の実装で同じ期待値を置く。
 */
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedPglite());
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
    // `putJob()` は `jobSchema.parse` で壊れた行を拒むので、版ずれ・手編集を
    // 模すために表へ直接書く。
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

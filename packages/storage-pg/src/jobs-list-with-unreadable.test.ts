import type { Job } from '@alteroid/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// `listJobsWithUnreadable()`: 読めた委譲と読めなかった行を、jobs 全行の scan 1回で返す

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

const secret = 'ghp_000000000000000000000000000000000000';

async function seed(): Promise<void> {
  const now = new Date().toISOString();
  const good: Job = {
    id: 'mgr-ok',
    createdAt: now,
    updatedAt: now,
    status: 'running',
    summary: '健全な行',
  };
  await stores.jobs.putJob(good);
  await db.execute(
    sql`insert into jobs (id, status, created_at, updated_at, job)
        values (
          'broken-1',
          'future-status',
          '2026-08-12T00:00:00.000Z',
          '2026-08-12T00:00:00.000Z',
          ${JSON.stringify({
            id: 'broken-1',
            status: 'future-status',
            createdAt: '2026-08-12T00:00:00.000Z',
            updatedAt: '2026-08-12T00:00:00.000Z',
            request: `秘密は ${secret} だった`,
          })}::jsonb
        )`,
  );
}

function loggedJobsStore(queries: string[]): PgStores['jobs'] {
  return createPgStoresFromDb(
    client.withLogger({
      logQuery: (text) => {
        queries.push(text);
      },
    }),
  ).jobs;
}

// jobs 表の scan（`select ... from "jobs"`）だけを数える
const jobsReads = (queries: string[]): string[] =>
  queries.filter((text) => /from "jobs"/.test(text));

describe('PgJobStore.listJobsWithUnreadable()', () => {
  it('読めた委譲・読めなかった行の両方が、listJobs() と listUnreadableJobs() を別々に呼んだ結果と同じ', async () => {
    await seed();

    const combined = await stores.jobs.listJobsWithUnreadable();

    expect(combined.jobs).toEqual(await stores.jobs.listJobs());
    expect(combined.unreadable).toEqual(await stores.jobs.listUnreadableJobs());
    expect(combined.jobs.map((job) => job.id)).toEqual(['mgr-ok']);
    expect(combined.unreadable).toEqual([{ id: 'broken-1', reason: '不正な欄: status,summary' }]);
    expect(JSON.stringify(combined.unreadable)).not.toContain(secret);
  });

  it('⭐ 覚えが温まっているとき、jobs への問い合わせは1回（別々に呼ぶと2回）', async () => {
    await seed();
    const queries: string[] = [];
    const logged = loggedJobsStore(queries);
    // 覚えを温める（冷たい1回目は本文を読む第2段が入る）
    await logged.listJobsWithUnreadable();

    queries.length = 0;
    await logged.listJobsWithUnreadable();
    expect(jobsReads(queries)).toHaveLength(1);

    queries.length = 0;
    await logged.listJobs();
    await logged.listUnreadableJobs();
    expect(jobsReads(queries)).toHaveLength(2);
  });

  it('⭐ 冷たい1回目でも scan は1回分（版の問い合わせ1 + 本文の問い合わせ1）', async () => {
    await seed();
    const queries: string[] = [];
    const logged = loggedJobsStore(queries);

    await logged.listJobsWithUnreadable();

    expect(jobsReads(queries)).toHaveLength(2);
  });
});

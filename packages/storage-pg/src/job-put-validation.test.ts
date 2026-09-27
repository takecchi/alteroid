import type { Job } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * issue #1715。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/job-put-validation.test.ts` の冒頭コメントを見よ。
 *
 * ここは pg 実装（PGlite）に対して同じ入力を当てる——`putJob()` が
 * `jobSchema.parse(job)` を通すので、この歯は緑になる。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
  stores = createPgStoresFromDb(db);
});

describe('JobStore.putJob() — 形式不正な job の扱い（pg 実装）', () => {
  const invalidJob = {
    id: 'mgr-invalid',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'not-a-real-status',
    summary: '不正な job',
  } as unknown as Job;

  it('putJob() は未知の status を拒む（throw する）', async () => {
    await expect(stores.jobs.putJob(invalidJob)).rejects.toThrow();
  });
});

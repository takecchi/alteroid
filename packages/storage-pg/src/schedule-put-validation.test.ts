import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb } from './test-db.test-support.js';

let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

describe('ScheduleStore.put() — 形式不正な entry の扱い（pg 実装）', () => {
  const now = new Date().toISOString();
  const invalidEntry = {
    kind: 'daily-report',
    spec: { type: 'every' as const, minutes: 60 },
    request: '',
    createdAt: now,
    updatedAt: now,
  };

  it('put() は空文字の request を拒む（throw する）', async () => {
    await expect(stores.schedules.put(invalidEntry)).rejects.toThrow();
  });
});

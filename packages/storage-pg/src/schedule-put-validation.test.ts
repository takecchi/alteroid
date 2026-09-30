import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * issue #1652。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/schedule-put-validation.test.ts` の冒頭コメントを見よ。
 *
 * ここは pg 実装（PGlite）に対して同じ入力を当てる——`put()` が
 * `scheduledRequestSchema.parse(entry)` を通すので、この歯は緑になる。
 */
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedPglite());
  stores = createPgStoresFromDb(db);
});

describe('ScheduleStore.put() — 形式不正な entry の扱い（pg 実装）', () => {
  const now = new Date().toISOString();
  const invalidEntry = {
    kind: 'daily-report',
    spec: { type: 'every' as const, minutes: 60 },
    request: '', // scheduledRequestSchema は request を min(1) で要求する
    createdAt: now,
    updatedAt: now,
  };

  it('put() は空文字の request を拒む（throw する）', async () => {
    await expect(stores.schedules.put(invalidEntry)).rejects.toThrow();
  });
});

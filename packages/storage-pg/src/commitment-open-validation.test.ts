import type { Commitment } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * issue #1652。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/commitment-open-validation.test.ts` の冒頭コメントを
 * 見よ。
 *
 * ここは pg 実装（PGlite）に対して同じ入力を当てる——`open()` が
 * `commitmentSchema.parse(entry)` を通すので、この歯は緑になる。
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

describe('CommitmentStore.open() — at が ISO 8601 でない entry の扱い（pg 実装）', () => {
  const badEntry = {
    id: 'c1',
    at: 'not-a-date',
    origin: 'self',
    body: '何か頼まれた',
  } as unknown as Commitment;

  it('open() は at が ISO 8601 でない entry を拒む（throw する）', async () => {
    await expect(stores.commitments.open(badEntry)).rejects.toThrow();
  });
});

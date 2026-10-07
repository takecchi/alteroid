import { verifyAuthNulContract } from '@alteroid/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

let client: Awaited<ReturnType<typeof createMigratedPglite>>['client'];
let db: Db;
let stores: PgStores;

// 最初の `beforeEach` で WASM の起動 + migrate を払わせない: `test-db.test-support.ts` を通らず前払いが掛からないため。
beforeAll(async () => {
  await migratedTemplate();
}, 60_000);

beforeEach(async () => {
  ({ client, db } = await createMigratedPglite());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

describe('AuthStore の NUL の契約（pg 実装）', () => {
  it('読むだけの口は「無い」と同じ結果、書き込みは鍵を断り本文を落として残す', async () => {
    await expect(verifyAuthNulContract(stores.auth)).resolves.toBeUndefined();
  });
});

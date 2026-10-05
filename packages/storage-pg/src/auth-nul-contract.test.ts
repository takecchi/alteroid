import { verifyAuthNulContract } from '@alteroid/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

let client: Awaited<ReturnType<typeof createMigratedPglite>>['client'];
let db: Db;
let stores: PgStores;

// 雛形の前払い（#3034）。この足場は `test-db.test-support.ts`（import すると自動で前払いが掛かる）を
// 通らず `createMigratedPglite` を直に呼ぶので、自分で払う。最初の `beforeEach`（hookTimeout 10s）で
// WASM の起動 + migrate を払わせない。
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

/** `AuthStore` の NUL の契約（issue #3011。3実装で同じことを測る）を pg 実装（PGlite）に対して測る。 */
describe('AuthStore の NUL の契約（pg 実装）', () => {
  it('読むだけの口は「無い」と同じ結果、書き込みは鍵を断り本文を落として残す', async () => {
    await expect(verifyAuthNulContract(stores.auth)).resolves.toBeUndefined();
  });
});

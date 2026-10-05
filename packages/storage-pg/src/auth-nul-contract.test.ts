import { verifyAuthNulContract } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

let client: Awaited<ReturnType<typeof createMigratedPglite>>['client'];
let db: Db;
let stores: PgStores;

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

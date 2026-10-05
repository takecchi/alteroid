import { verifyListOrderContract } from '@alteroid/core';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

/**
 * 一覧の並びの契約（#2913）。`ALTEROID_TEST_PG_URL` が無ければ PGlite（照合順 C）、
 * あれば本物の PostgreSQL（CI の `storage-pg-real-postgres.yml` が `en_US.UTF-8` と
 * `C` の2本で回す）。`collate "C"` が本番の照合順で効くかは、後者で確かめる。
 */
let client: TestDbHandle;
let stores: PgStores;

beforeEach(async () => {
  const made = await createMigratedTestDb();
  client = made.client;
  stores = createPgStoresFromDb(made.db);
});

afterEach(async () => {
  await client.close();
});

describe('一覧の並びの契約（#2913）— pg', () => {
  it('名前の並びがコード単位の順である', async () => {
    await verifyListOrderContract(stores);
  });
});

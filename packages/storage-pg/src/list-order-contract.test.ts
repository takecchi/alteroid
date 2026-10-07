import { verifyListOrderContract } from '@alteroid/core';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

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

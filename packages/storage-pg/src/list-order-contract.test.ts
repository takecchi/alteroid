import { verifyListOrderContract } from '@alteroid/core';
import { afterEach, beforeEach, describe, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

let client: PGlite;
let stores: PgStores;

beforeEach(async () => {
  const made = await createMigratedPglite();
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

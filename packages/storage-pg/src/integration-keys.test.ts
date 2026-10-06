import { verifyIntegrationKeyStoreContract } from '@alteroid/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

let client: Awaited<ReturnType<typeof createMigratedPglite>>['client'];
let stores: PgStores;

beforeAll(async () => {
  await migratedTemplate();
}, 60_000);

beforeEach(async () => {
  const made = await createMigratedPglite();
  client = made.client;
  stores = createPgStoresFromDb(made.db);
});

afterEach(async () => {
  await client.close();
});

describe('IntegrationKeyStore（pg 実装）', () => {
  it('3実装共通の契約を満たす', async () => {
    await expect(
      verifyIntegrationKeyStoreContract(stores.integrationKeys),
    ).resolves.toBeUndefined();
  });
});

import { verifyJournalStoreHumanActionContract } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let stores: PgStores;

beforeEach(async () => {
  let db;
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

describe('JournalStore の decision.humanAction 契約（pg 実装）', () => {
  it('humanAction は追記して読み戻しても欄ごと返り、無い行は印なしのまま読める', async () => {
    await expect(verifyJournalStoreHumanActionContract(stores.journal)).resolves.toBeUndefined();
  });
});

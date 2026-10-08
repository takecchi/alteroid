import { verifyCodexChatgptAuthContract } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

describe('PgCodexChatgptAuthStore（#3939）', () => {
  it('約束（3実装で同じことを測る）', async () => {
    await verifyCodexChatgptAuthContract(stores.codexAuth);
  });

  it('migrate を2回通しても置いたログインが残る', async () => {
    await stores.codexAuth.replace({
      value: '{}',
      revision: 'r1',
      updatedAt: '2026-10-07T00:00:00.000Z',
      email: 'me@example.com',
      planType: 'pro',
      failure: null,
    });
    await migrate(db);
    expect((await stores.codexAuth.get())?.revision).toBe('r1');
  });
});

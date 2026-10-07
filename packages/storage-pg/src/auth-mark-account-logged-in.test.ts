import type { AuthAccount } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
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

describe('AuthStore.markAccountLoggedIn（pg 実装、issue #1870）', () => {
  it('lastLoginAt だけを書き、grantedAt / grantedBy / ownerDeclaredAt には触れない。無い id では何もしない', async () => {
    const store = stores.auth;
    const account: AuthAccount = {
      id: 'account-mark',
      displayName: 'Alice',
      email: 'alice@example.test',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastLoginAt: '2026-09-01T00:00:00.000Z',
      grantedAt: '2026-09-02T00:00:00.000Z',
      grantedBy: 'operator',
      ownerDeclaredAt: '2026-09-03T00:00:00.000Z',
    };
    await store.putAccount(account);

    await store.markAccountLoggedIn(account.id, '2026-09-04T00:00:00.000Z');
    const updated = await store.getAccount(account.id);
    expect(updated?.lastLoginAt).toBe('2026-09-04T00:00:00.000Z');
    expect(updated?.grantedAt).toBe('2026-09-02T00:00:00.000Z');
    expect(updated?.grantedBy).toBe('operator');
    expect(updated?.ownerDeclaredAt).toBe('2026-09-03T00:00:00.000Z');
    expect(updated?.email).toBe('alice@example.test');
    expect(updated?.displayName).toBe('Alice');

    await expect(
      store.markAccountLoggedIn('no-such-account', '2026-09-05T00:00:00.000Z'),
    ).resolves.toBeUndefined();
  });
});

import type { AuthAccount } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * `AuthStore.revokeAccountAccess`（issue #1915）単体の歯（pg 実装、PGlite）。
 *
 * `PgAuthStore.revokeAccountAccess` は条件無しの UPDATE 1文で `granted_at` /
 * `granted_by` / `owner_declared_at` の3列だけを書く。ここでは単体で、
 * 他の列（`last_login_at` / `email` / `display_name`）に触れないことを見る。
 */

let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

describe('AuthStore.revokeAccountAccess（pg 実装、issue #1915）', () => {
  it('grantedAt / grantedBy / ownerDeclaredAt だけを null にし、他の欄には触れない。無い id では何もしない', async () => {
    const store = stores.auth;
    const account: AuthAccount = {
      id: 'account-revoke',
      displayName: 'Alice',
      email: 'alice@example.test',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastLoginAt: '2026-09-04T00:00:00.000Z',
      grantedAt: '2026-09-02T00:00:00.000Z',
      grantedBy: 'operator',
      ownerDeclaredAt: '2026-09-03T00:00:00.000Z',
    };
    await store.putAccount(account);

    await store.revokeAccountAccess(account.id);
    const updated = await store.getAccount(account.id);
    expect(updated?.grantedAt).toBeNull();
    expect(updated?.grantedBy).toBeNull();
    expect(updated?.ownerDeclaredAt).toBeNull();
    expect(updated?.lastLoginAt).toBe('2026-09-04T00:00:00.000Z');
    expect(updated?.email).toBe('alice@example.test');
    expect(updated?.displayName).toBe('Alice');

    // 無い id では何も起きない（投げない）。
    await expect(store.revokeAccountAccess('no-such-account')).resolves.toBeUndefined();
  });
});

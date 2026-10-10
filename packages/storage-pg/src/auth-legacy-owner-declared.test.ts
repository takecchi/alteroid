import { sql } from 'drizzle-orm';
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

// #2948: 持ち主の宣言の仕組みを畳んだ。列 `owner_declared_at` は落とさず残す（既存の DB に値が入っている）ので、
// 値が入ったままの行を読んでも・許可の取り消しや再ログインの書き込みを通しても壊れないことを確かめる。
describe('AuthStore — owner_declared_at に値が残った旧い行（pg、#2948）', () => {
  const account = {
    id: 'account-legacy',
    displayName: 'Alice',
    email: 'alice@example.test',
    createdAt: '2026-09-01T00:00:00.000Z',
    lastLoginAt: '2026-09-04T00:00:00.000Z',
    grantedAt: '2026-09-02T00:00:00.000Z',
    grantedBy: 'operator',
  };

  async function seedLegacyRow(): Promise<void> {
    await stores.auth.putAccount(account);
    await db.execute(
      sql`update auth_accounts set owner_declared_at = '2026-09-03T00:00:00Z' where id = ${account.id}`,
    );
  }

  it('値の入った行は、宣言の欄を持たない形でそのまま読める（getAccount / listAccounts）', async () => {
    await seedLegacyRow();

    const read = await stores.auth.getAccount(account.id);
    expect(read).toEqual(account);
    expect(read).not.toHaveProperty('ownerDeclaredAt');
    expect(await stores.auth.listAccounts()).toEqual([account]);
  });

  it('値の入った行にも、許可の取り消し・再ログイン・putAccount が通り、他の欄は壊れない', async () => {
    await seedLegacyRow();

    await stores.auth.markAccountLoggedIn(account.id, '2026-09-05T00:00:00.000Z');
    expect((await stores.auth.getAccount(account.id))?.lastLoginAt).toBe(
      '2026-09-05T00:00:00.000Z',
    );

    await stores.auth.revokeAccountAccess(account.id);
    expect(await stores.auth.getAccount(account.id)).toEqual({
      ...account,
      lastLoginAt: '2026-09-05T00:00:00.000Z',
      grantedAt: null,
      grantedBy: null,
    });

    await stores.auth.putAccount({ ...account, displayName: 'Alice 2' });
    expect((await stores.auth.getAccount(account.id))?.displayName).toBe('Alice 2');
  });
});

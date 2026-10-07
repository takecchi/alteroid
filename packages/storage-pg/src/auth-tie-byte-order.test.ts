import type { AccessTokenRecord, AuthAccount, AuthIdentity } from '@alteroid/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import {
  createMigratedTestDb,
  realPostgresUrl,
  type TestDbHandle,
} from './test-db.test-support.js';

const TIE = '2026-01-05T00:00:00.000Z';
const INSERT_ORDER = ['ab', 'a-x', '_z', 'B_x', 'Ab', '9'];
const EXPECTED = ['9', 'Ab', 'B_x', '_z', 'a-x', 'ab'];
const PROVIDER_INSERT_ORDER = ['ab', 'a_b', 'a0', 'a-b'];
const PROVIDER_EXPECTED = ['a-b', 'a0', 'a_b', 'ab'];

const account = (id: string): AuthAccount => ({
  id,
  displayName: null,
  email: null,
  createdAt: TIE,
  lastLoginAt: null,
  grantedAt: null,
  grantedBy: null,
  ownerDeclaredAt: null,
});

const identity = (provider: string, subject: string): AuthIdentity => ({
  provider,
  subject,
  accountId: 'account-1',
  email: null,
  emailVerified: false,
  createdAt: TIE,
  lastLoginAt: TIE,
});

const token = (id: string, n: number): AccessTokenRecord => ({
  id,
  accountId: 'account-1',
  sha256: n.toString(16).padStart(64, '0'),
  label: id,
  createdAt: TIE,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
});

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

function defineTieCases(): void {
  it('listAccounts: 同着の id はバイト順', async () => {
    for (const id of INSERT_ORDER) await stores.auth.putAccount(account(id));

    expect((await stores.auth.listAccounts()).map((it) => it.id)).toEqual(EXPECTED);
  });

  it('listIdentities: 同着の subject はバイト順', async () => {
    await stores.auth.putAccount({
      ...account('account-1'),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    for (const subject of INSERT_ORDER) await stores.auth.putIdentity(identity('google', subject));

    expect((await stores.auth.listIdentities('account-1')).map((it) => it.subject)).toEqual(
      EXPECTED,
    );
  });

  it('listIdentities: 同着の provider はバイト順', async () => {
    await stores.auth.putAccount({
      ...account('account-1'),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    for (const provider of PROVIDER_INSERT_ORDER) {
      await stores.auth.putIdentity(identity(provider, 's'));
    }

    expect((await stores.auth.listIdentities('account-1')).map((it) => it.provider)).toEqual(
      PROVIDER_EXPECTED,
    );
  });

  it('listAccessTokens: 同着の id はバイト順', async () => {
    await stores.auth.putAccount({
      ...account('account-1'),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    let n = 1;
    for (const id of INSERT_ORDER) await stores.auth.putAccessToken(token(id, n++));

    expect((await stores.auth.listAccessTokens('account-1')).map((it) => it.id)).toEqual(EXPECTED);
  });
}

describe('AuthStore の同着の2次キーはバイト順（pg 実装・既定の照合順、issue #2458）', () => {
  // 「既定が C」を前提にしない: 本物の PostgreSQL の照合順は接続先で決まり、前提は PGlite でだけ成り立つため。
  it.skipIf(realPostgresUrl() !== undefined)('前提: この DB の既定の照合順は C', async () => {
    const result = await client.query<{ datcollate: string }>(
      'select datcollate from pg_database where datname = current_database()',
    );
    expect(result.rows).toEqual([{ datcollate: 'C' }]);
  });

  defineTieCases();
});

describe('AuthStore の同着の2次キーはバイト順（pg 実装・列の照合順が C でない DB、issue #2458）', () => {
  beforeEach(async () => {
    await db.execute(sql`alter table auth_accounts alter column id type text collate "unicode"`);
    await db.execute(
      sql`alter table auth_access_tokens alter column id type text collate "unicode"`,
    );
    await db.execute(
      sql`alter table auth_identities alter column provider type text collate "unicode"`,
    );
    await db.execute(
      sql`alter table auth_identities alter column subject type text collate "unicode"`,
    );
  });

  it('前提: 列の照合順のまま並べると C の順にならない', async () => {
    for (const id of INSERT_ORDER) await stores.auth.putAccount(account(id));
    const result = await client.query<{ id: string }>(
      'select id from auth_accounts order by id asc',
    );
    const plain = result.rows.map((row) => row.id);

    expect(plain).toHaveLength(EXPECTED.length);
    expect(plain).not.toEqual(EXPECTED);
  });

  defineTieCases();
});

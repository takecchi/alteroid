import type { AccessTokenRecord, AuthAccount, AuthIdentity } from '@alteroid/core';
import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * **issue #2458。** 経緯とインメモリ側の対の歯は
 * `packages/core/src/auth-tie-byte-order.test.ts` の冒頭コメントを見よ。
 *
 * ここは pg 実装に対して同じ入力・同じ期待値を当てる（fs は
 * `packages/storage-fs/src/auth-tie-byte-order.test.ts`）。
 *
 * **PGlite の既定の照合順は C なので、そのままでは直す前から緑である。** 本番の pg
 * が `en_US.UTF-8` などで作られていた場合を写すために、2本目の `describe` では
 * 2次キーの列の照合順を ICU の `"unicode"` へ変えてから同じ入力を当てる。直す前の
 * pg 実装（`asc(authAccounts.id)` など、列の既定の照合順に任せる形）はそこで赤く
 * なる。
 */
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

let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedPglite());
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
  it('前提: この DB の既定の照合順は C', async () => {
    const result = await client.query<{ datcollate: string }>(
      'select datcollate from pg_database where datname = current_database()',
    );
    expect(result.rows).toEqual([{ datcollate: 'C' }]);
  });

  defineTieCases();
});

describe('AuthStore の同着の2次キーはバイト順（pg 実装・列の照合順が C でない DB、issue #2458）', () => {
  beforeEach(async () => {
    // 本番の pg が C 以外の照合順で作られていた場合を写す。列の型は変えず、
    // 照合順だけを ICU の `"unicode"` にする（この照合順では `_z, 9, a-x, ab, Ab, B_x`）。
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

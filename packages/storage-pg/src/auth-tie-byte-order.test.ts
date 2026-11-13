import type { AuthAccount } from '@alteroid/core';
import { verifyAuthTieByteOrderContract } from '@alteroid/core/contracts';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb } from './index.js';
import {
  createMigratedTestDb,
  realPostgresUrl,
  type TestDbHandle,
} from './test-db.test-support.js';

// 並びの契約そのもの（同着の2次キーはバイト順）は core の `verifyAuthTieByteOrderContract`。ここに残すのは pg 固有の「照合順序」の前提だけ:
// DB の既定の照合順・列の照合順が C でないときに、素の `order by` では契約の順にならないこと（契約が空振りしていないことの確認）。
const TIE = '2026-01-05T00:00:00.000Z';
const INSERT_ORDER = ['ab', 'a-x', '_z', 'B_x', 'Ab', '9'];
const EXPECTED = ['9', 'Ab', 'B_x', '_z', 'a-x', 'ab'];

const account = (id: string): AuthAccount => ({
  id,
  displayName: null,
  email: null,
  createdAt: TIE,
  lastLoginAt: null,
  grantedAt: null,
  grantedBy: null,
});

const opened: TestDbHandle[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((client) => client.close()));
});

async function openDb(): Promise<{ client: TestDbHandle; db: Db }> {
  const handle = await createMigratedTestDb();
  opened.push(handle.client);
  return handle;
}

// 列の照合順を C でないものへ替える
async function useUnicodeCollation(db: Db): Promise<void> {
  await db.execute(sql`alter table auth_accounts alter column id type text collate "unicode"`);
  await db.execute(sql`alter table auth_access_tokens alter column id type text collate "unicode"`);
  await db.execute(
    sql`alter table auth_identities alter column provider type text collate "unicode"`,
  );
  await db.execute(
    sql`alter table auth_identities alter column subject type text collate "unicode"`,
  );
}

describe('AuthStore の同着の2次キーはバイト順（pg 実装・既定の照合順、issue #2458）', () => {
  // 「既定が C」を前提にしない: 本物の PostgreSQL の照合順は接続先で決まり、前提は PGlite でだけ成り立つため。
  it.skipIf(realPostgresUrl() !== undefined)('前提: この DB の既定の照合順は C', async () => {
    const { client } = await openDb();
    const result = await client.query<{ datcollate: string }>(
      'select datcollate from pg_database where datname = current_database()',
    );
    expect(result.rows).toEqual([{ datcollate: 'C' }]);
  });

  it('同着の2次キーはバイト順の契約', async () => {
    await verifyAuthTieByteOrderContract(
      async () => createPgStoresFromDb((await openDb()).db).auth,
    );
  }, 60_000);
});

describe('AuthStore の同着の2次キーはバイト順（pg 実装・列の照合順が C でない DB、issue #2458）', () => {
  it('前提: 列の照合順のまま並べると C の順にならない', async () => {
    const { client, db } = await openDb();
    await useUnicodeCollation(db);
    const stores = createPgStoresFromDb(db);
    for (const id of INSERT_ORDER) await stores.auth.putAccount(account(id));
    const result = await client.query<{ id: string }>(
      'select id from auth_accounts order by id asc',
    );
    const plain = result.rows.map((row) => row.id);

    expect(plain).toHaveLength(EXPECTED.length);
    expect(plain).not.toEqual(EXPECTED);
  });

  it('同着の2次キーはバイト順の契約', async () => {
    await verifyAuthTieByteOrderContract(async () => {
      const { db } = await openDb();
      await useUnicodeCollation(db);
      return createPgStoresFromDb(db).auth;
    });
  }, 60_000);
});

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { migrate } from './migrate.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 移行の残骸の列（`auth_accounts.owner_declared_at`、`practices.bytes`）の扱いを、書き換えの前後で変わらない範囲で固定する。
// `owner_declared_at` が在るか無いかは縛らない（その列を足す文を、落とす文へ置き換える予定のため）。
// 縛るのは、それ以外の列の名前と型、`bytes` が無いこと、古い形の DB を移行しても行と中身が保たれること、移行を重ねても落ちないこと。

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

interface ColumnRow {
  column_name: string;
  data_type: string;
}

async function columnsOf(table: string): Promise<Array<[string, string]>> {
  const result = await client.query<ColumnRow>(
    `select column_name, data_type from information_schema.columns
      where table_schema = current_schema() and table_name = '${table}'
      order by column_name`,
  );
  return result.rows.map((row) => [row.column_name, row.data_type]);
}

async function hasColumn(table: string, column: string): Promise<boolean> {
  return (await columnsOf(table)).some(([name]) => name === column);
}

describe('新しい DB の列', () => {
  it('auth_accounts は owner_declared_at 以外の列がこの一覧', async () => {
    const columns = (await columnsOf('auth_accounts')).filter(
      ([name]) => name !== 'owner_declared_at',
    );

    expect(columns).toEqual([
      ['created_at', 'timestamp with time zone'],
      ['display_name', 'text'],
      ['email', 'text'],
      ['granted_at', 'timestamp with time zone'],
      ['granted_by', 'text'],
      ['id', 'text'],
      ['last_login_at', 'timestamp with time zone'],
    ]);
  });

  it('practices は bytes を含まず、列がこの一覧', async () => {
    expect(await columnsOf('practices')).toEqual([
      ['content', 'text'],
      ['created_at', 'timestamp with time zone'],
      ['kind', 'text'],
      ['slug', 'text'],
      ['title', 'text'],
      ['updated_at', 'timestamp with time zone'],
    ]);
  });
});

describe('古い形の既存の DB を移行する', () => {
  const account = {
    id: 'account-leftover',
    displayName: 'Alice',
    email: 'alice@example.test',
    createdAt: '2026-09-01T00:00:00.000Z',
    lastLoginAt: '2026-09-04T00:00:00.000Z',
    grantedAt: '2026-09-02T00:00:00.000Z',
    grantedBy: 'operator',
  };

  // 古い形: 生 SQL で残骸の列を足し、値を入れる（列を足す文は、書き換えの前後どちらでも動くよう `if not exists`）。
  async function seedLegacyShape(): Promise<void> {
    await migrate(db);
    await client.exec(
      `alter table auth_accounts add column if not exists owner_declared_at timestamptz`,
    );
    await stores.auth.putAccount(account);
    await db.execute(
      sql`update auth_accounts set owner_declared_at = '2026-09-03T00:00:00Z' where id = ${account.id}`,
    );
    await client.exec(
      `alter table practices add column if not exists bytes integer not null default 0`,
    );
    await client.exec(
      `insert into practices (slug, kind, title, content, bytes, created_at, updated_at)
       values ('legacy-practice', 'howto', 'Legacy', E'body\\n', 5, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')`,
    );
    expect(await hasColumn('auth_accounts', 'owner_declared_at')).toBe(true);
    expect(await hasColumn('practices', 'bytes')).toBe(true);
  }

  it('移行を2回打っても落ちず、アカウントの中身が保たれる', async () => {
    await seedLegacyShape();

    await migrate(db);
    await migrate(db);

    expect(await stores.auth.getAccount(account.id)).toEqual(account);
    expect(await stores.auth.listAccounts()).toEqual([account]);
  }, 30_000);

  it('移行後も practices が読め、bytes 列は無い', async () => {
    await seedLegacyShape();

    await migrate(db);
    await migrate(db);

    expect(await hasColumn('practices', 'bytes')).toBe(false);
    const read = await stores.practices.read('legacy-practice');
    expect(read).toMatchObject({
      slug: 'legacy-practice',
      kind: 'howto',
      title: 'Legacy',
      content: 'body\n',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    });
    const list = await stores.practices.list();
    expect(list.entries.map((entry) => entry.slug)).toEqual(['legacy-practice']);
    expect(list.unreadable).toEqual([]);
  }, 30_000);
});

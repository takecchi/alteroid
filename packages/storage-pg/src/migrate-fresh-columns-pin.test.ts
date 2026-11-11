import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { migrate } from './migrate.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 新しい DB の `auth_accounts`・`practices` の列の名前と型を固定する。かつて移行で落としていた残骸の列（`auth_accounts.owner_declared_at`、`practices.bytes`）は、
// その移行の文を外したので、新しい DB に無いこと・新しい書き込みが落ちないこと・移行を重ねても落ちず中身が保たれることを縛る。

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

describe('新しい DB の列', () => {
  it('auth_accounts は owner_declared_at を含まず、列がこの一覧', async () => {
    expect(await columnsOf('auth_accounts')).toEqual([
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

describe('新しい DB への書き込みと、移行の重ね打ち', () => {
  const account = {
    id: 'account-fresh',
    displayName: 'Alice',
    email: 'alice@example.test',
    createdAt: '2026-09-01T00:00:00.000Z',
    lastLoginAt: '2026-09-04T00:00:00.000Z',
    grantedAt: '2026-09-02T00:00:00.000Z',
    grantedBy: 'operator',
  };

  it('アカウントを書いて読み戻せ、移行を重ねても落ちず中身が保たれる', async () => {
    await stores.auth.putAccount(account);

    await migrate(db);
    await migrate(db);

    expect(await stores.auth.getAccount(account.id)).toEqual(account);
    expect(await stores.auth.listAccounts()).toEqual([account]);
  }, 30_000);

  it('practices を書いて読み戻せ、移行を重ねても落ちず中身が保たれる（bytes 列が無くても insert が落ちない）', async () => {
    await stores.practices.write({
      slug: 'fresh-practice',
      kind: 'howto',
      title: 'Fresh',
      content: 'body\n',
    });

    await migrate(db);
    await migrate(db);

    const read = await stores.practices.read('fresh-practice');
    expect(read).toMatchObject({
      slug: 'fresh-practice',
      kind: 'howto',
      title: 'Fresh',
      content: 'body\n',
    });
    const list = await stores.practices.list();
    expect(list.entries.map((entry) => entry.slug)).toEqual(['fresh-practice']);
    expect(list.unreadable).toEqual([]);
  }, 30_000);
});

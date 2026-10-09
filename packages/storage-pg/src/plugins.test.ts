import { verifyPluginStoreContract } from '@alteroid/core';
import type { PluginInput } from '@alteroid/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';
import { pluginFiles } from './schema.js';
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

const SHA = 'd'.repeat(40);

const input = (name = 'my-plugin'): PluginInput => ({
  name,
  source: { kind: 'url', url: 'https://example.invalid/repo', sha: SHA },
  files: [
    { path: '.claude-plugin/plugin.json', executable: false, content: new Uint8Array([123, 125]) },
    { path: 'run.sh', executable: true, content: new Uint8Array([0, 255]) },
  ],
  installedAt: '2026-10-07T00:00:00.000Z',
  installedBy: 'account-1',
});

describe('PgPluginStore', () => {
  it('器の契約（3実装で同じことを測る）', async () => {
    await verifyPluginStoreContract(stores.plugins);
  });

  it('migrate を2回通しても置いた plugin が残る（create table if not exists が no-op）', async () => {
    await stores.plugins.put(input());
    await migrate(db);
    const got = await stores.plugins.get('my-plugin');
    expect(got?.files.map((f) => f.path)).toEqual(['.claude-plugin/plugin.json', 'run.sh']);
  });

  it('description 列が無い古い表でも migrate が列を足し、既存の行は説明なしで読める', async () => {
    await stores.plugins.put(input('old-one'));
    await db.execute(sql`alter table plugins drop column description`);
    await migrate(db);
    await migrate(db);
    const listed = await stores.plugins.list();
    expect(listed.map((p) => p.name)).toEqual(['old-one']);
    expect(listed[0]).not.toHaveProperty('description');
    expect(await stores.plugins.get('old-one')).not.toHaveProperty('description');
    await stores.plugins.put({ ...input('new-one'), description: 'この plugin の説明' });
    const after = await stores.plugins.list();
    expect(after.find((p) => p.name === 'new-one')?.description).toBe('この plugin の説明');
    expect(after.find((p) => p.name === 'old-one')).not.toHaveProperty('description');
  });

  it('list は plugin_files を読まない（説明は plugins の行から返す）', async () => {
    await stores.plugins.put({ ...input(), description: '説明' });
    await db.execute(sql`update plugin_files set content = '\\x53454352455431'::bytea`);
    expect((await stores.plugins.list())[0]?.description).toBe('説明');
  });

  it('外すと files の行も消える（外部キーの cascade）', async () => {
    await stores.plugins.put(input());
    await stores.plugins.remove('my-plugin');
    expect(await db.select().from(pluginFiles)).toEqual([]);
  });

  it('置き換えは1つのトランザクション（files の途中で落ちても前の登録が残る）', async () => {
    await stores.plugins.put(input());
    const before = await stores.plugins.get('my-plugin');
    await db.execute(sql`
      create function plugin_files_fail() returns trigger as $$
      begin
        if new.path = 'boom' then raise exception 'boom'; end if;
        return new;
      end $$ language plpgsql
    `);
    await db.execute(
      sql`create trigger plugin_files_fail_t before insert on plugin_files for each row execute function plugin_files_fail()`,
    );
    await expect(
      stores.plugins.put({
        ...input(),
        files: [
          { path: 'ok', executable: false, content: new Uint8Array([1]) },
          { path: 'boom', executable: false, content: new Uint8Array([2]) },
        ],
      }),
    ).rejects.toThrow();
    expect(await stores.plugins.get('my-plugin')).toEqual(before);
  });

  it('get は plugins と files を1つのトランザクションで読む（置き換えの途中の版を混ぜない）', async () => {
    await stores.plugins.put(input());
    let transactions = 0;
    let outerSelects = 0;
    const spy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (...args: unknown[]) => {
            transactions += 1;
            return (target.transaction as (...a: unknown[]) => unknown)(...args);
          };
        }
        if (prop === 'select') outerSelects += 1;
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const spied = createPgStoresFromDb(spy);
    expect((await spied.plugins.get('my-plugin'))?.files).toHaveLength(2);
    expect(transactions).toBe(1);
    expect(outerSelects).toBe(0);
  });

  it('SQL で files を書き換えられた行は、contentSha256 と合わなければ読むときに投げる', async () => {
    await stores.plugins.put(input());
    await db.execute(
      sql`update plugin_files set content = '\\x53454352455431'::bytea where path = 'run.sh'`,
    );
    await expect(stores.plugins.get('my-plugin')).rejects.toThrow(/my-plugin|contentSha256/);
    await expect(stores.plugins.get('my-plugin')).rejects.not.toThrow(/SECRET1/);
  });

  it('SQL で直接書かれた不正な source / scope の行も、読むときに検査する', async () => {
    await stores.plugins.put(input());
    await db.execute(
      sql`update plugins set source = '{"kind":"url","url":"http://insecure.invalid/x","sha":"abc"}'::jsonb`,
    );
    await expect(stores.plugins.get('my-plugin')).rejects.toThrow(/my-plugin/);
  });
});

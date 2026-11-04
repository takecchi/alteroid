import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { migrate } from './migrate.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 実行環境のプロファイル（`env_profile_entries`）の、移行と片付けに関わる振る舞いを固定する。
// 旧表 `env_profile` を落とす前後で変わらないことを縛る: 移行は起動のたびに打たれるので、何度打っても新表の行を動かさないこと。
// `clear()` は、新表を消す文が落ちたら投げて、新表の行を残すこと。

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

describe('実行環境のプロファイルの移行と片付け', () => {
  it('新表に行がある状態で移行を何度打っても、行は変わらない', async () => {
    await stores.profile.set('alpha', 'export A=1\n', 'all');
    await stores.profile.set('beta', 'export B=1\n', 'runner');
    const before = await stores.profile.list();

    await migrate(db);
    await migrate(db);

    expect(await stores.profile.list()).toEqual(before);
  }, 30_000);

  it('新表が空のまま移行を打っても、行は増えない', async () => {
    await migrate(db);

    expect(await stores.profile.list()).toEqual([]);
  }, 30_000);

  it('clear() は、新表を消す文が落ちたら投げて、新表の行を残す', async () => {
    await stores.profile.set('keep', 'export KEEP=1\n', 'all');
    await client.exec(`
      CREATE OR REPLACE FUNCTION forbid_profile_entries_delete_pin() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forbid_profile_entries_delete_pin: 仕込んだ失敗';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await client.exec(`
      CREATE TRIGGER env_profile_entries_forbid_delete_pin
        BEFORE DELETE ON env_profile_entries
        FOR EACH ROW
        EXECUTE FUNCTION forbid_profile_entries_delete_pin();
    `);

    await expect(stores.profile.clear()).rejects.toThrow(
      /Failed query: delete from "env_profile_entries"/,
    );

    expect((await stores.profile.list()).map((row) => row.name)).toEqual(['keep']);
  });
});

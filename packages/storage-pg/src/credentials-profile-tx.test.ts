import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { managerCredentials } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 複数文の書き込みを1つのトランザクションで行う（#4727）。2文目で失敗を仕込み、1文目が確定していないことを見る

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

describe('CredentialVaultStore.put() — 削除と書き込みを1つのトランザクションで行う（#4727）', () => {
  it('⭐ 書き込みの途中で落ちたら、先に打った削除もロールバックされる', async () => {
    await stores.credentials.put([{ name: 'OLD_KEY', value: 'old' }]);
    await client.exec(`
      CREATE OR REPLACE FUNCTION forbid_bad_credential() RETURNS trigger AS $$
      BEGIN
        IF NEW.name = 'BAD_KEY' THEN
          RAISE EXCEPTION 'forbid_bad_credential: 仕込んだ失敗（issue #4727 の歯）';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await client.exec(`
      CREATE TRIGGER manager_credentials_forbid_bad
        BEFORE INSERT ON manager_credentials
        FOR EACH ROW
        EXECUTE FUNCTION forbid_bad_credential();
    `);

    await expect(
      stores.credentials.put([
        { name: 'OLD_KEY', value: '' },
        { name: 'GOOD_KEY', value: 'good' },
        { name: 'BAD_KEY', value: 'bad' },
      ]),
    ).rejects.toThrow(/insert into "manager_credentials"/);

    const rows = await db.select().from(managerCredentials);
    expect(rows.map((row) => row.name).sort()).toEqual(['OLD_KEY']);
  });
});

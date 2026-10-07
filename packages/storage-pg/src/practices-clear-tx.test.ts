import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { practices } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);

  await client.exec(`
    CREATE OR REPLACE FUNCTION forbid_practice_versions_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forbid_practice_versions_delete: 仕込んだ失敗（issue #1955 の歯）';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await client.exec(`
    CREATE TRIGGER practice_versions_forbid_delete
      BEFORE DELETE ON practice_versions
      FOR EACH ROW
      EXECUTE FUNCTION forbid_practice_versions_delete();
  `);
});

describe('PracticeStore.clear() — 本体と版の履歴を1つのトランザクションで消す（issue #1955）', () => {
  it('practice_versions の DELETE が失敗したら、practices の DELETE もロールバックされる', async () => {
    await stores.practices.write({
      slug: 'mgr-tx-good',
      kind: 'howto',
      title: '正常なやり方',
      content: '本文',
    });

    // 例外の中身を見る: ほかの理由で先に落ちても行は残り、緑になってしまうため。drizzle は例外を `Failed query: <SQL>` で包むので SQL の側で見る。
    await expect(stores.practices.clear()).rejects.toThrow(
      /Failed query: delete from "practice_versions"/,
    );

    const remainingPractices = await db.select().from(practices);
    expect(remainingPractices.map((row) => row.slug)).toEqual(['mgr-tx-good']);
  });
});

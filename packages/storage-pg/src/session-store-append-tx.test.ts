import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { sessionEntries } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

const KEY = { projectKey: 'proj-1', sessionId: 'sess-1' };

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);

  // `db.execute` / `client.query` を使わない: "cannot insert multiple commands into a prepared statement" で落ちるため、`client.exec` を使う。
  await client.exec(`
    CREATE OR REPLACE FUNCTION forbid_sessions_insert() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forbid_sessions_insert: 仕込んだ失敗（issue #1962 の歯）';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await client.exec(`
    CREATE TRIGGER sessions_forbid_insert
      BEFORE INSERT ON sessions
      FOR EACH ROW
      EXECUTE FUNCTION forbid_sessions_insert();
  `);
});

describe('PgSessionStore.append() — session_entries と索引の sessions を1つのトランザクションで積む（issue #1962）', () => {
  it('sessions への insert が失敗したら、session_entries への insert もロールバックされる', async () => {
    await expect(
      stores.sessionStore.append(KEY, [
        { type: 'user', uuid: 'evt-1', text: 'hi（uuid 付き）' },
        { type: 'user', text: 'notes（uuid 無し）' },
      ]),
    ).rejects.toThrow(/Failed query: insert into "sessions"/);

    const remainingEntries = await db.select().from(sessionEntries);
    expect(remainingEntries).toEqual([]);
  });
});

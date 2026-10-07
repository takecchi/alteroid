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
    CREATE OR REPLACE FUNCTION forbid_sessions_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forbid_sessions_delete: 仕込んだ失敗（issue #1961 の歯）';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await client.exec(`
    CREATE TRIGGER sessions_forbid_delete
      BEFORE DELETE ON sessions
      FOR EACH ROW
      EXECUTE FUNCTION forbid_sessions_delete();
  `);
});

describe('PgSessionStore.delete() — session_entries と sessions を1つのトランザクションで消す（issue #1961）', () => {
  it('sessions の DELETE が失敗したら、session_entries の DELETE もロールバックされる', async () => {
    await stores.sessionStore.append(KEY, [{ type: 'user', uuid: 'evt-1', text: 'hi' }]);

    // 例外の中身を見る: ほかの理由で先に落ちても行は残り、緑になってしまうため。drizzle は例外を `Failed query: <SQL>` で包むので SQL の側で見る。
    await expect(stores.sessionStore.delete(KEY)).rejects.toThrow(
      /Failed query: delete from "sessions"/,
    );

    const remainingEntries = await db.select().from(sessionEntries);
    expect(remainingEntries.map((row) => row.uuid)).toEqual(['evt-1']);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { sessionEntries } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

/**
 * issue #1961。`PgSessionStore.delete()` の契約は「session_entries と索引の
 * sessions を両方消す」（`append` が両方へ書くのと対）。
 *
 * `sessions` への DELETE だけが失敗するよう BEFORE DELETE トリガを仕込み、
 * `delete()` が例外を投げた後に **session_entries の行が残っている**（＝ロール
 * バックされた）ことを見る。1つのトランザクションで束ねていない実装（直す前の
 * `PgSessionStore.delete()`）は、session_entries の DELETE を確定させたあとで
 * sessions の DELETE に失敗するので、この歯は赤くなる。
 */
let client: TestDbHandle;
let db: Db;
let stores: PgStores;

const KEY = { projectKey: 'proj-1', sessionId: 'sess-1' };

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);

  // sessions への DELETE だけを確実に失敗させる（BEFORE DELETE トリガ）。
  // `client.exec`（複数文を1回で流せる）を使う——`db.execute` / `client.query`
  // は "cannot insert multiple commands into a prepared statement" で落ちる
  // （jobs-clear-tx.test.ts と同じ実測）。
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

    // sessions の DELETE で落ちたことまで見る。ほかの理由で session_entries の
    // DELETE の前に落ちても session_entries は残るので、例外の中身を見ないと
    // 緑になってしまう。drizzle は仕込んだ例外を `Failed query: <SQL>` で包む
    // ので、SQL の側で見る。
    await expect(stores.sessionStore.delete(KEY)).rejects.toThrow(
      /Failed query: delete from "sessions"/,
    );

    // ロールバックされていれば、session_entries の行は消えずに残っているはず。
    const remainingEntries = await db.select().from(sessionEntries);
    expect(remainingEntries.map((row) => row.uuid)).toEqual(['evt-1']);
  });
});

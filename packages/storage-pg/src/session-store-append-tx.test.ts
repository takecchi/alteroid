import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { sessionEntries } from './schema.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * issue #1962。`PgSessionStore.append(key, entries)` は最大3つの insert を
 * 続けて打つ——(1) uuid 付きの行を `session_entries` へ（冪等）、(2) uuid の
 * 無い行を `session_entries` へ（冪等ではない）、(3) 索引の `sessions` を
 * upsert。
 *
 * `sessions` への insert だけが失敗するよう BEFORE INSERT トリガを仕込み、
 * `append()` が例外を投げた後に **session_entries に行が1つも残っていない**
 * （＝(1)(2) の両方がロールバックされた）ことを見る。1つのトランザクションで
 * 束ねていない実装（直す前の `PgSessionStore.append()`）は、(1)(2) の insert
 * を確定させたあとで (3) の insert に失敗するので、この歯は赤くなる。
 *
 * `entries` には uuid 付きの行と uuid の無い行の両方を入れる —— 束ねていない
 * 実装では、どちらも確定してしまっている（冪等かどうかに関わらず両方残る）
 * ことを見るため。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

const KEY = { projectKey: 'proj-1', sessionId: 'sess-1' };

beforeEach(async () => {
  ({ client, db } = await createMigratedPglite());
  stores = createPgStoresFromDb(db);

  // sessions への insert だけを確実に失敗させる（BEFORE INSERT トリガ）。
  // `client.exec`（複数文を1回で流せる）を使う——`db.execute` / `client.query`
  // は "cannot insert multiple commands into a prepared statement" で落ちる
  // （jobs-clear-tx.test.ts と同じ実測）。
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
    // uuid 付きの行（冪等）と uuid の無い行（冪等ではない）の両方を入れる。
    await expect(
      stores.sessionStore.append(KEY, [
        { type: 'user', uuid: 'evt-1', text: 'hi（uuid 付き）' },
        { type: 'user', text: 'notes（uuid 無し）' },
      ]),
    ).rejects.toThrow(/Failed query: insert into "sessions"/);

    // ロールバックされていれば、session_entries には1行も残っていないはず
    // （uuid 付き・uuid 無しのどちらも）。
    const remainingEntries = await db.select().from(sessionEntries);
    expect(remainingEntries).toEqual([]);
  });
});

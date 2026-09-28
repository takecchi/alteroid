import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';
import { practices } from './schema.js';

/**
 * issue #1955（#1929 の同じ形の残り）。`PracticeStore.clear()` の契約は「やり方の
 * 本体と版の履歴を一緒に消す」（`packages/core/src/store.ts` の `PracticeStore.clear`
 * の doc、#1309）。
 *
 * `practice_versions` への DELETE だけが失敗するよう BEFORE DELETE トリガを仕込み、
 * `clear()` が例外を投げた後に **practices の行が残っている**（＝ロールバックされた）
 * ことを見る。1つのトランザクションで束ねていない実装（直す前の
 * `PgPracticeStore.clear()`）は、practices の DELETE を確定させたあとで
 * practice_versions の DELETE に失敗するので、この歯は赤くなる。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
  stores = createPgStoresFromDb(db);

  // practice_versions への DELETE だけを確実に失敗させる（BEFORE DELETE トリガ）。
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

    // practice_versions の DELETE で落ちたことまで見る。ほかの理由で practices の
    // DELETE の前に落ちても practices は残るので、例外の中身を見ないと緑になって
    // しまう。drizzle は仕込んだ例外を `Failed query: <SQL>` で包むので、SQL の側で見る。
    await expect(stores.practices.clear()).rejects.toThrow(
      /Failed query: delete from "practice_versions"/,
    );

    // ロールバックされていれば、practices の行は消えずに残っているはず。
    const remainingPractices = await db.select().from(practices);
    expect(remainingPractices.map((row) => row.slug)).toEqual(['mgr-tx-good']);
  });
});

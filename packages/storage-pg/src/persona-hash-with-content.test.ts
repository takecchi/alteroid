import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 記憶の本文とハッシュ（content_sha256）は同じ1文で書く（#4739）。後の派生の更新が落ちても、本文とハッシュがずれない

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

// 本文を変えない UPDATE（＝ 本文の書き込みの後の派生の更新）だけを落とす
async function forbidDerivedUpdate(): Promise<void> {
  await client.exec(`
    CREATE OR REPLACE FUNCTION forbid_memory_derived_update() RETURNS trigger AS $$
    BEGIN
      IF OLD.content = NEW.content THEN
        RAISE EXCEPTION 'forbid_memory_derived_update: 仕込んだ失敗（issue #4739 の歯）';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await client.exec(`
    CREATE TRIGGER memory_forbid_derived_update
      BEFORE UPDATE ON memory
      FOR EACH ROW
      EXECUTE FUNCTION forbid_memory_derived_update();
  `);
}

describe('記憶の本文とハッシュを同じ1文で書く（#4739）', () => {
  it('⭐ 全文置換の後の派生の更新が落ちたら、置換ごと巻き戻り、ハッシュは元の本文と合ってクローンの記憶のまま（unknown にならない）', async () => {
    await stores.persona.write('notes', '一つ目\n');
    await forbidDerivedUpdate();

    await expect(stores.persona.write('notes', '二つ目\n')).rejects.toThrow();

    // 本文と派生値は1つのトランザクション: 失敗した書き込みは本文ごと巻き戻り、ハッシュは残った（元の）本文と合う
    expect((await stores.persona.read('notes'))?.content).toBe('一つ目\n');
    expect(await stores.persona.protectionStatus('notes')).toEqual({ kind: 'clone-only' });
  });

  it('⭐ 追記の後の派生の更新が落ちたら、追記ごと巻き戻り、ハッシュは元の本文と合う', async () => {
    await stores.persona.write('notes', '一つ目\n');
    await forbidDerivedUpdate();

    await expect(stores.persona.append('notes', '足した行')).rejects.toThrow();

    expect((await stores.persona.read('notes'))?.content).toBe('一つ目\n');
    expect(await stores.persona.protectionStatus('notes')).toEqual({ kind: 'clone-only' });
  });
});

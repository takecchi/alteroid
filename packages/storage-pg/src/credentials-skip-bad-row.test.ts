import { captureStderr } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * issue #1740。pg 実装は元から `list()` の中で `CREDENTIAL_NAME` に合わない行を
 * `filter` で1行ずつ飛ばしており（fs 版のように配列全体を1回で検査していない）、
 * ここは main でも赤くならない——**跡（stderr）が無かった**ことを直す歯である
 * （3実装の振る舞いをそろえる。詳しい経緯は fs 版
 * `packages/storage-fs/src/credentials-skip-bad-row.test.ts` の冒頭コメント）。
 *
 * DB は人間が直接 `insert` できる（`PgCredentialVaultStore.list()` の doc）ので、
 * ここでは `put()` を使って名前の形式検査を経由せずに不正な行を作る——
 * `PgCredentialVaultStore.put()` 自体は `CREDENTIAL_NAME` を検査しない
 * （検査は読みの `list()` 側にしかない）。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

const FAKE_GOOD_VALUE = 'ghp_FAKEFAKE1111111111111111111111111111';
const FAKE_BAD_VALUE = 'ghp_FAKEFAKE2222222222222222222222222222';
const BAD_NAME = '../../etc/bad-name';

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
  stores = createPgStoresFromDb(db);
});

describe('PgCredentialVaultStore.list() — 不正な1行を読み飛ばす（issue #1740）', () => {
  async function seedRows(): Promise<void> {
    await stores.credentials.put([
      { name: 'GH_TOKEN', value: FAKE_GOOD_VALUE },
      { name: BAD_NAME, value: FAKE_BAD_VALUE },
    ]);
  }

  it('list() は不正な行を飛ばし、正しい行だけを返す', async () => {
    await seedRows();

    const rows = await stores.credentials.list();

    expect(rows.map((row) => row.name)).toEqual(['GH_TOKEN']);
    expect(rows[0]?.value).toBe(FAKE_GOOD_VALUE);
  });

  it('跡: 飛ばした行を stderr へ1行出す。値は絶対に含めない', async () => {
    await seedRows();

    const lines = await captureStderr(async () => {
      await stores.credentials.list();
    });
    const joined = lines.join('');

    expect(joined).toContain(BAD_NAME);
    expect(joined).not.toContain(FAKE_GOOD_VALUE);
    expect(joined).not.toContain(FAKE_BAD_VALUE);
  });

  it('不正な行は表に残る（読みの口が配る集合から外すだけで、消しはしない）', async () => {
    await seedRows();
    await stores.credentials.list();

    const { managerCredentials } = await import('./schema.js');
    const raw = await db.select().from(managerCredentials);

    expect(raw.map((row) => row.name).sort()).toEqual([BAD_NAME, 'GH_TOKEN']);
  });
});

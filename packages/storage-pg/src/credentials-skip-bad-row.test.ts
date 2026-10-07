import { captureStderr } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb } from './test-db.test-support.js';
import { managerCredentials } from './schema.js';

let db: Db;
let stores: PgStores;

const FAKE_GOOD_VALUE = 'ghp_FAKEFAKE1111111111111111111111111111';
const FAKE_BAD_VALUE = 'ghp_FAKEFAKE2222222222222222222222222222';
const BAD_NAME = '../../etc/bad-name';

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

describe('PgCredentialVaultStore.list() — 不正な1行を読み飛ばす（issue #1740）', () => {
  async function seedRows(): Promise<void> {
    await stores.credentials.put([{ name: 'GH_TOKEN', value: FAKE_GOOD_VALUE }]);
    await db
      .insert(managerCredentials)
      .values({ name: BAD_NAME, value: FAKE_BAD_VALUE, updatedAt: new Date() });
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

    const raw = await db.select().from(managerCredentials);

    expect(raw.map((row) => row.name).sort()).toEqual([BAD_NAME, 'GH_TOKEN']);
  });
});

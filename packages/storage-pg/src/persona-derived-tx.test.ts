import { memoryVersion } from '@alteroid/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

// `#updateDerived` の UPDATE（本文も updated_at も変えず、described_* だけを書く文）だけを投げさせる:
// 本文の書き込みの文は content / updated_at が変わるので通る。試験の中だけの DDL で、マイグレーションには触らない
async function failDerivedUpdates(): Promise<void> {
  await db.execute(sql`
    create function memory_fail_derived() returns trigger as $$
    begin
      raise exception 'injected: derived update failed';
    end;
    $$ language plpgsql
  `);
  await db.execute(sql`
    create trigger memory_fail_derived_trg
    before update on memory
    for each row
    when (new.content is not distinct from old.content and new.updated_at is not distinct from old.updated_at)
    execute function memory_fail_derived()
  `);
}

describe('記憶の write は、本文の書き換えと派生値の更新を1つのトランザクションにする', () => {
  it('派生値の更新だけが失敗したとき、本文も印も変わらない（ifMatch なし）', async () => {
    await stores.persona.write('values', '# 価値観\n\nV1\n');
    await failDerivedUpdates();

    await expect(
      stores.persona.write('values', '# 価値観\n\n人間の編集\n', {
        humanTouchedAt: '2026-11-01T00:00:00.000Z',
      }),
    ).rejects.toThrow();

    expect((await stores.persona.read('values'))?.content).toBe('# 価値観\n\nV1\n');
    expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });
  });

  it('派生値の更新だけが失敗したとき、本文も印も変わらない（ifMatch あり）', async () => {
    await stores.persona.write('values', '# 価値観\n\nV1\n');
    const v1 = memoryVersion('# 価値観\n\nV1\n');
    await failDerivedUpdates();

    await expect(
      stores.persona.write('values', '# 価値観\n\n人間の編集\n', {
        ifMatch: v1,
        humanTouchedAt: '2026-11-01T00:00:00.000Z',
      }),
    ).rejects.toThrow();

    expect((await stores.persona.read('values'))?.content).toBe('# 価値観\n\nV1\n');
    expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });
  });

  it('派生値の更新だけが失敗したとき、新規作成も残らない（ifMatch: null）', async () => {
    await failDerivedUpdates();

    await expect(
      stores.persona.write('values', '# 価値観\n\n新規\n', {
        ifMatch: null,
        humanTouchedAt: '2026-11-01T00:00:00.000Z',
      }),
    ).rejects.toThrow();

    expect(await stores.persona.read('values')).toBeNull();
  });

  it('append も、派生値の更新だけが失敗したら本文を足さない', async () => {
    await stores.persona.write('values', '# 価値観\n\nV1\n');
    await failDerivedUpdates();

    await expect(stores.persona.append('values', '追記')).rejects.toThrow();

    expect((await stores.persona.read('values'))?.content).toBe('# 価値観\n\nV1\n');
  });
});

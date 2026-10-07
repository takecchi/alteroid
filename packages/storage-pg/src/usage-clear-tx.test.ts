import type { UsageSnapshot } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { usageBaseline, usageDaily, usageLedger } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

const SNAPSHOT: UsageSnapshot = {
  models: {
    opus: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 1,
    },
  },
};

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);

  await client.exec(`
    CREATE OR REPLACE FUNCTION forbid_usage_turns_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forbid_usage_turns_delete: 仕込んだ失敗（issue #1955 の歯）';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await client.exec(`
    CREATE TRIGGER usage_turns_forbid_delete
      BEFORE DELETE ON usage_turns
      FOR EACH ROW
      EXECUTE FUNCTION forbid_usage_turns_delete();
  `);
});

describe('UsageStore.clear() — 4表を1つのトランザクションで消す（issue #1955）', () => {
  it('usage_turns の DELETE が失敗したら、先の3表の DELETE もロールバックされる', async () => {
    await stores.usage.record({
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-tx-good',
      date: '2026-09-01',
      at: '2026-09-01T00:00:00.000Z',
      snapshot: SNAPSHOT,
      accumulation: 'cumulative',
    });

    // 例外の中身を見る: ほかの理由で先に落ちても行は残り、緑になってしまうため。drizzle は例外を `Failed query: <SQL>` で包むので SQL の側で見る。
    await expect(stores.usage.clear()).rejects.toThrow(/Failed query: delete from "usage_turns"/);

    const remainingDaily = await db.select().from(usageDaily);
    expect(remainingDaily.map((row) => row.managerId)).toEqual(['mgr-tx-good']);

    const remainingBaseline = await db.select().from(usageBaseline);
    expect(remainingBaseline.map((row) => row.managerId)).toEqual(['mgr-tx-good']);

    const remainingLedger = await db.select().from(usageLedger);
    expect(remainingLedger.map((row) => row.id)).toEqual(['default']);
  });
});

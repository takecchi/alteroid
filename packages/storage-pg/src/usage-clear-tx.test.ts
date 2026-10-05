import type { UsageSnapshot } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { usageBaseline, usageDaily, usageLedger } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

/**
 * issue #1955（#1929 の同じ形の残り）。`UsageStore.clear()` の契約は「台帳
 * （`usage_daily` / `usage_baseline` / `usage_ledger` / `usage_turns` に当たる
 * 4つの単位）を丸ごと消す」（`packages/core/src/store.ts` の `UsageStore.clear`
 * の doc）。
 *
 * `usage_turns`（最後に DELETE される表）への DELETE だけが失敗するよう
 * BEFORE DELETE トリガを仕込み、`clear()` が例外を投げた後に **usage_daily /
 * usage_baseline / usage_ledger の行がすべて残っている**（＝ロールバックされた）
 * ことを見る。1つのトランザクションで束ねていない実装（直す前の
 * `PgUsageStore.clear()`）は、先の3表の DELETE を確定させたあとで usage_turns
 * の DELETE に失敗するので、この歯は赤くなる。
 */
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

  // usage_turns への DELETE だけを確実に失敗させる（BEFORE DELETE トリガ）。
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

    // usage_turns の DELETE で落ちたことまで見る。ほかの理由で先の3表の DELETE の
    // 前に落ちてもそちらは残るので、例外の中身を見ないと緑になってしまう。drizzle は
    // 仕込んだ例外を `Failed query: <SQL>` で包むので、SQL の側で見る。
    await expect(stores.usage.clear()).rejects.toThrow(/Failed query: delete from "usage_turns"/);

    // ロールバックされていれば、先の3表の行は消えずに残っているはず。
    const remainingDaily = await db.select().from(usageDaily);
    expect(remainingDaily.map((row) => row.managerId)).toEqual(['mgr-tx-good']);

    const remainingBaseline = await db.select().from(usageBaseline);
    expect(remainingBaseline.map((row) => row.managerId)).toEqual(['mgr-tx-good']);

    const remainingLedger = await db.select().from(usageLedger);
    expect(remainingLedger.map((row) => row.id)).toEqual(['default']);
  });
});

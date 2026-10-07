import { captureStderr } from '@alteroid/core';
import type { UsageSnapshot } from '@alteroid/core';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { usageDaily, usageTurns } from './schema.js';
import { createMigratedTestDb } from './test-db.test-support.js';

let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

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

async function recordFor(managerId: string): Promise<void> {
  await stores.usage.record({
    layer: 'manager',
    site: 'session',
    managerId,
    date: '2026-09-28',
    at: '2026-09-28T00:00:00.000Z',
    snapshot: SNAPSHOT,
    accumulation: 'cumulative',
  });
}

describe('PgUsageStore.aggregate — layer / site の壊れた1行で集計ごと落とさない', () => {
  it('usage_daily と usage_turns の1行ずつが enum に無い layer を持っても、ほかの行は読める', async () => {
    await recordFor('mgr-good');
    await recordFor('mgr-bad');
    await db
      .update(usageDaily)
      .set({ layer: 'not-a-real-layer-from-a-newer-deploy' })
      .where(eq(usageDaily.managerId, 'mgr-bad'));
    await db
      .update(usageTurns)
      .set({ layer: 'not-a-real-layer-from-a-newer-deploy' })
      .where(eq(usageTurns.managerId, 'mgr-bad'));

    let rows: string[] = [];
    let turnRows: string[] = [];
    const stderr = (
      await captureStderr(async () => {
        const result = await stores.usage.aggregate({});
        rows = result.rows.map((row) => row.managerId);
        turnRows = result.turnRows.map((row) => row.managerId);
      })
    ).join('');

    expect(rows).toEqual(['mgr-good']);
    expect(turnRows).toEqual(['mgr-good']);
    expect(stderr).toContain('mgr-bad');
    expect(stderr, '壊れた値そのものは跡に出さない').not.toContain('not-a-real-layer');
  });

  it('対照: 壊れた行が無ければ、今までどおり全行を読み、跡も出さない', async () => {
    await recordFor('mgr-a');
    await recordFor('mgr-b');

    let rows: string[] = [];
    const stderr = (
      await captureStderr(async () => {
        rows = (await stores.usage.aggregate({})).rows.map((row) => row.managerId).sort();
      })
    ).join('');

    expect(rows).toEqual(['mgr-a', 'mgr-b']);
    expect(stderr).toBe('');
  });
});

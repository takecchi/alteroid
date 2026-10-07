import {
  USAGE_ESTIMATE_NOTICE,
  describeUnreadableUsage,
  modelUsageOf,
  summarizeUsage,
  type UsageSnapshot,
} from '@alteroid/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { STATEMENTS, migrate } from './migrate.js';
import {
  createEmptyTestDb,
  createMigratedTestDb,
  type TestDbHandle,
} from './test-db.test-support.js';
import { PgUsageStore } from './usage.js';

let client: TestDbHandle;
let db: Db;
let store: PgUsageStore;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  store = new PgUsageStore(db);
});

afterEach(async () => {
  await client.close();
});

const BASE = {
  layer: 'manager',
  site: 'session',
  managerId: 'mgr-1',
  date: '2026-10-01',
  accumulation: 'cumulative',
} as const;

function snapshot(models: Record<string, unknown>): UsageSnapshot {
  const read = modelUsageOf({ modelUsage: models });
  if (read === undefined) throw new Error('modelUsage が読めない');
  return { models: read };
}

const FULL = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0.25,
};

const WITHOUT_COST = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
};

function rowsOf(result: unknown): Record<string, unknown>[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Record<
    string,
    unknown
  >[];
}

async function dumpLedgerTables(target: Db): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [table, order] of [
    ['usage_daily', 'date, manager_id, model, layer, site, token_id'],
    ['usage_turns', 'date, manager_id, layer, site, token_id'],
    ['usage_baseline', 'layer, manager_id'],
    ['usage_ledger', 'id'],
  ] as const) {
    out[table] = rowsOf(await target.execute(sql.raw(`select * from ${table} order by ${order}`)));
  }
  return out;
}

describe('費用の欄が無い使用量は、0 として合計に混ざらず「取れなかった」になる（pg）', () => {
  it('costUSD が無い区間は costUsd=0 の行になり、unreadable.costUsd に数えられ、表示が取れなかったと言う', async () => {
    const withoutCost = WITHOUT_COST;
    await store.record({
      ...BASE,
      at: '2026-10-01T10:00:00.000Z',
      snapshot: snapshot({ opus: withoutCost }),
    });

    const { rows, turnRows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.inputTokens).toBe(100);
    expect(rows[0]?.totals.costUsd).toBe(0);
    expect(rows[0]?.totals.unreadable).toEqual({ costUsd: 1 });
    expect(turnRows).toHaveLength(1);

    const summary = summarizeUsage(rows, turnRows);
    expect(describeUnreadableUsage(summary.total)).toEqual([
      '⚠ 一部の区切りで SDK から値が取れなかった（0 ではなく取れなかった。取れなかった数: 費用 1回）。',
    ]);
  });

  it('費用が読めた区間には unreadable が付かない（対照）', async () => {
    await store.record({
      ...BASE,
      at: '2026-10-01T10:00:00.000Z',
      snapshot: snapshot({ opus: FULL }),
    });
    const { rows } = await store.aggregate({});
    expect(rows[0]?.totals.costUsd).toBe(0.25);
    expect(rows[0]?.totals).not.toHaveProperty('unreadable');
  });
});

describe('PgUsageStore.recordUnmetered（無報告の provider のターン）', () => {
  const UNMETERED = {
    layer: 'clone',
    site: 'session',
    managerId: 'clone',
    date: '2026-10-01',
    provider: 'codex',
  } as const;

  it('無報告の行が無ければ、aggregate に unmeteredRows の鍵ごと無い（既存の応答を変えない）', async () => {
    await store.record({
      ...BASE,
      at: '2026-10-01T10:00:00.000Z',
      snapshot: snapshot({ opus: FULL }),
    });
    const aggregate = await store.aggregate({});
    expect(aggregate).not.toHaveProperty('unmeteredRows');
    expect(Object.keys(aggregate).sort()).toEqual(
      [
        'beforeLayers',
        'beforeLedger',
        'beforeTokens',
        'beforeTurns',
        'layersSince',
        'notice',
        'rows',
        'since',
        'tokensSince',
        'turnRows',
        'turnsSince',
      ].sort(),
    );
    expect(aggregate.notice).toBe(USAGE_ESTIMATE_NOTICE);
  });

  it('1回数えると1行（turns=1）。usage_daily / usage_turns / 基準 / 台帳には1行も増えない（0 を積まない）', async () => {
    await store.record({
      ...BASE,
      at: '2026-10-01T10:00:00.000Z',
      snapshot: snapshot({ opus: FULL }),
    });
    const tablesBefore = await dumpLedgerTables(db);
    const before = await store.aggregate({});

    await store.recordUnmetered({ ...UNMETERED, at: '2026-10-01T11:00:00.000Z' });

    expect(await dumpLedgerTables(db)).toEqual(tablesBefore);
    const { unmeteredRows, ...rest } = await store.aggregate({});
    expect(rest).toEqual(before);
    expect(unmeteredRows).toEqual([
      {
        date: '2026-10-01',
        managerId: 'clone',
        layer: 'clone',
        site: 'session',
        provider: 'codex',
        turns: 1,
        updatedAt: '2026-10-01T11:00:00.000Z',
      },
    ]);
  });

  it('無報告だけの器でも、台帳の行・始点は動かない（since は null のまま）', async () => {
    await store.recordUnmetered({ ...UNMETERED, at: '2026-10-01T11:00:00.000Z' });
    const aggregate = await store.aggregate({});
    expect(aggregate.rows).toEqual([]);
    expect(aggregate.turnRows).toEqual([]);
    expect(aggregate.since).toBeNull();
    expect(aggregate.unmeteredRows).toHaveLength(1);
    expect((await dumpLedgerTables(db)).usage_daily).toEqual([]);
  });

  it('同じ鍵は足し込み、provider とトークンが違えば別の行になる', async () => {
    await store.recordUnmetered({ ...UNMETERED, at: '2026-10-01T11:00:00.000Z' });
    await store.recordUnmetered({ ...UNMETERED, at: '2026-10-01T12:00:00.000Z' });
    await store.recordUnmetered({
      ...UNMETERED,
      provider: 'other',
      at: '2026-10-01T12:00:00.000Z',
    });
    await store.recordUnmetered({ ...UNMETERED, tokenId: 'tok-1', at: '2026-10-01T12:00:00.000Z' });

    const { unmeteredRows } = await store.aggregate({});
    expect(unmeteredRows?.map((row) => [row.provider, row.tokenId ?? null, row.turns])).toEqual([
      ['codex', 'tok-1', 1],
      ['codex', null, 2],
      ['other', null, 1],
    ]);
  });

  it('照会の絞り込み（日・層）が効く。範囲外なら鍵ごと無い', async () => {
    await store.recordUnmetered({ ...UNMETERED, at: '2026-10-01T11:00:00.000Z' });
    expect((await store.aggregate({ from: '2026-10-02' })).unmeteredRows).toBeUndefined();
    expect((await store.aggregate({ layer: 'manager' })).unmeteredRows).toBeUndefined();
    expect((await store.aggregate({ layer: 'clone' })).unmeteredRows).toHaveLength(1);
  });

  it('clear() は無報告の行も消す（返り値の型は広げない）', async () => {
    await store.recordUnmetered({ ...UNMETERED, at: '2026-10-01T11:00:00.000Z' });
    const removed = await store.clear();
    expect(Object.keys(removed).sort()).toEqual(['baseline', 'daily', 'ledger', 'turns']);
    expect((await store.aggregate({})).unmeteredRows).toBeUndefined();
  });
});

describe('既存の行の集計値は、S3 の migrate を通しても変わらない（pg）', () => {
  let legacyClient: TestDbHandle;
  let legacyDb: Db;

  beforeEach(async () => {
    ({ client: legacyClient, db: legacyDb } = await createEmptyTestDb());
    for (const statement of STATEMENTS.filter((s) => !s.includes('usage_unmetered'))) {
      await legacyDb.execute(sql.raw(statement));
    }
  });

  afterEach(async () => {
    await legacyClient.close();
  });

  it('migrate 前に積んだ行から、migrate を2回通しても 4表の中身が同じで aggregate も新規 DB と同じ。無報告を足しても増えない', async () => {
    const withoutCost = WITHOUT_COST;
    const seed = async (target: PgUsageStore) => {
      await target.record({
        ...BASE,
        at: '2026-10-01T10:00:00.000Z',
        snapshot: snapshot({ opus: FULL, sonnet: withoutCost }),
      });
      await target.record({
        ...BASE,
        layer: 'clone',
        managerId: 'clone',
        tokenId: 'tok-1',
        at: '2026-10-01T10:30:00.000Z',
        snapshot: snapshot({ opus: FULL }),
      });
    };

    const legacyStore = new PgUsageStore(legacyDb);
    await seed(legacyStore);
    await expect(legacyDb.execute(sql.raw('select 1 from usage_unmetered'))).rejects.toThrow();
    const tablesBefore = await dumpLedgerTables(legacyDb);
    expect(tablesBefore.usage_daily?.length).toBeGreaterThan(0);

    await seed(store);
    const reference = await store.aggregate({});

    await migrate(legacyDb);
    await migrate(legacyDb);

    expect(await dumpLedgerTables(legacyDb)).toEqual(tablesBefore);
    expect(await legacyStore.aggregate({})).toEqual(reference);

    await legacyStore.recordUnmetered({
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      date: '2026-10-01',
      provider: 'codex',
      at: '2026-10-01T11:00:00.000Z',
    });
    expect(await dumpLedgerTables(legacyDb)).toEqual(tablesBefore);
    const { unmeteredRows, ...rest } = await legacyStore.aggregate({});
    expect(rest).toEqual(reference);
    expect(unmeteredRows).toHaveLength(1);
    expect(summarizeUsage(rest.rows, rest.turnRows)).toEqual(
      summarizeUsage(reference.rows, reference.turnRows),
    );
  });
});

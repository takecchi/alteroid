import {
  USAGE_ESTIMATE_NOTICE,
  ZERO_USAGE,
  verifyUsageNulContract,
  verifyUsageRunnerContract,
  type UsageAccumulation,
  type UsageLayer,
  type UsageSite,
  type UsageSnapshot,
  type UsageTotals,
} from '@alteroid/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { migrate } from './migrate.js';
import {
  createEmptyTestDb,
  createMigratedTestDb,
  type TestDbHandle,
} from './test-db.test-support.js';
import { PgUsageStore } from './usage.js';

let client: TestDbHandle;
let db: Db;
let store: PgUsageStore;

function totals(over: Partial<UsageTotals>): UsageTotals {
  return { ...ZERO_USAGE, ...over };
}

function snapshot(models: Record<string, UsageTotals>): UsageSnapshot {
  return { models };
}

function record(input: {
  managerId: string;
  date: string;
  at: string;
  snapshot: UsageSnapshot;
  layer?: UsageLayer;
  site?: UsageSite;
  accumulation?: UsageAccumulation;
}) {
  return store.record({
    layer: 'manager',
    site: 'session',
    accumulation: 'cumulative',
    ...input,
  });
}

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  store = new PgUsageStore(db);
});

afterEach(async () => {
  await client.close();
});

describe('PgUsageStore.record', () => {
  it('同じ累積スナップショットを2回 record しても合計が増えない（二重計上しない）', async () => {
    const input = {
      managerId: 'mgr-1',
      date: '2026-08-14',
      snapshot: snapshot({ opus: totals({ outputTokens: 100, costUsd: 1 }) }),
    };
    await record({ ...input, at: '2026-08-14T10:00:00.000Z' });
    await record({ ...input, at: '2026-08-14T10:00:05.000Z' });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals).toEqual(totals({ outputTokens: 100, costUsd: 1 }));
  });

  it('累積が増えれば差分だけ足し込む（upsert が set ではなく加算であること）', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ outputTokens: 100, costUsd: 1 }) }),
    });
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T11:00:00.000Z',
      snapshot: snapshot({ opus: totals({ outputTokens: 250, costUsd: 3 }) }),
    });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals).toEqual(totals({ outputTokens: 250, costUsd: 3 }));
    expect(typeof rows[0]?.totals.outputTokens).toBe('number');
  });

  it('累積が減っても、記録済みの合計は減らない（新しい累積の全量を足す）', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 5 }) }),
    });
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T11:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 3 }) }),
    });

    const { rows } = await store.aggregate({});
    expect(rows[0]?.totals.costUsd).toBe(8);
  });

  it('同じ日にモデルをまたいで積んでも別の行になる（主キーは date, manager_id, model）', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({
        opus: totals({ costUsd: 1 }),
        sonnet: totals({ costUsd: 0.1 }),
      }),
    });

    const { rows } = await store.aggregate({});
    expect(rows.map((r) => r.model).sort()).toEqual(['opus', 'sonnet']);
  });

  it('基準（baseline）を読み戻せる', async () => {
    expect(await store.baseline('manager', 'mgr-1')).toBeNull();

    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { sessionId: 'sess-1', models: { opus: totals({ costUsd: 1 }) } },
    });

    const baseline = await store.baseline('manager', 'mgr-1');
    expect(baseline?.managerId).toBe('mgr-1');
    expect(baseline?.sessionId).toBe('sess-1');
    expect(baseline?.models.opus).toEqual(totals({ costUsd: 1 }));
  });

  it('数え直しが起きたら reset を返す（呼び出し側が日誌へ落とす材料）', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 5 }) }),
    });
    const fold = await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T11:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 3 }) }),
    });

    expect(fold.reset).toBeDefined();
    expect(fold.reset?.fromCostUsd).toBe(5);
    expect(fold.reset?.toCostUsd).toBe(3);
  });

  it('台帳の開始時刻は最初の record でだけ入る（以後は上書きしない）', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });
    await record({
      managerId: 'mgr-2',
      date: '2026-08-15',
      at: '2026-08-15T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });

    const { since } = await store.aggregate({});
    expect(since).toBe('2026-08-14T10:00:00.000Z');
  });
});

describe('PgUsageStore と unreadable（読めなかった区切りの数。Issue #2086）', () => {
  it('毎ターン同じ欄が読めない回が続くと、usage_daily の列へ足し込まれる（加算であって上書きではない）', async () => {
    // 6欄すべてを動かす: 1つでも欠くと、その欄だけ足し込みが壊れても最初の record の INSERT が値を書いてしまい気づけないため。
    const unreadable = {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 1,
      webSearchRequests: 1,
      costUsd: 1,
    };
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1, unreadable }) }),
    });
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T11:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 2, unreadable }) }),
    });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals).toEqual(
      totals({
        costUsd: 2,
        unreadable: {
          inputTokens: 2,
          outputTokens: 2,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 2,
          webSearchRequests: 2,
          costUsd: 2,
        },
      }),
    );
  });

  it('unreadable が無い回だけなら、読み出した行に欄そのものが無い（既存の出力を変えない）', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });

    const { rows } = await store.aggregate({});
    expect(rows[0]?.totals).not.toHaveProperty('unreadable');
  });

  it('欄ごとに独立して足し込む（1欄だけ読めない回と、別の1欄だけ読めない回が混ざっても互いを侵さない）', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1, unreadable: { inputTokens: 1 } }) }),
    });
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T11:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 2, unreadable: { webSearchRequests: 1 } }) }),
    });

    const { rows } = await store.aggregate({});
    expect(rows[0]?.totals.unreadable).toEqual({ inputTokens: 1, webSearchRequests: 1 });
  });
});

describe('PgUsageStore.aggregate', () => {
  it('1件も無ければ since は null', async () => {
    const aggregate = await store.aggregate({});
    expect(aggregate.since).toBeNull();
    expect(aggregate.rows).toEqual([]);
    expect(aggregate.notice).toBe(USAGE_ESTIMATE_NOTICE);
  });

  it('日・マネージャー・モデルの3軸で引ける', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-13',
      at: '2026-08-13T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 3 }) }),
    });
    await record({
      managerId: 'mgr-2',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ sonnet: totals({ costUsd: 0.2 }) }),
    });

    const byDate = await store.aggregate({ from: '2026-08-14', to: '2026-08-14' });
    expect(byDate.rows).toHaveLength(2);

    const byManager = await store.aggregate({ managerId: 'mgr-1' });
    expect(byManager.rows.map((r) => r.date).sort()).toEqual(['2026-08-13', '2026-08-14']);

    const all = await store.aggregate({});
    expect(all.rows.map((r) => r.model).sort()).toEqual(['opus', 'opus', 'sonnet']);
  });

  it('台帳の始点より前を照会したら beforeLedger: true になる', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });

    const before = await store.aggregate({ from: '2026-08-01', to: '2026-08-05' });
    expect(before.beforeLedger).toBe(true);
    expect(before.rows).toEqual([]);

    const after = await store.aggregate({ from: '2026-08-14', to: '2026-08-14' });
    expect(after.beforeLedger).toBe(false);
    expect(after.since).toBe('2026-08-14T10:00:00.000Z');
  });

  it('下限の無い照会は台帳の前を含みうるので beforeLedger: true', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });

    expect((await store.aggregate({})).beforeLedger).toBe(true);
  });
});

// 増える累積を並行に投げて「合計 = 最後の累積」を期待しない: 本物の PostgreSQL では lock の取得順が呼んだ順と前後し、store が正しくても合計が一致しないため。到着順に依存しない形で書く。
describe('PgUsageStore の不変条件（並行の record は直列化される）', () => {
  it('同一の累積スナップショットを並行に record すると、合計はちょうど1回ぶん', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        record({
          managerId: 'mgr-1',
          date: '2026-08-14',
          at: `2026-08-14T10:00:${String(i).padStart(2, '0')}.000Z`,
          snapshot: snapshot({ opus: totals({ outputTokens: 100, costUsd: 10 }) }),
        }),
      ),
    );

    expect(results.filter((r) => Object.keys(r.delta).length > 0)).toHaveLength(1);
    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBe(10);
    expect(rows[0]?.totals.outputTokens).toBe(100);
  });

  it('並行に増える累積を record しても、各呼び出しは別々の前任者を読み、増分が重ならない', async () => {
    const calls = Array.from({ length: 10 }, (_, i) => i + 1);
    const results = await Promise.all(
      calls.map((i) =>
        record({
          managerId: 'mgr-1',
          date: '2026-08-14',
          at: `2026-08-14T10:00:${String(i).padStart(2, '0')}.000Z`,
          snapshot: snapshot({ opus: totals({ outputTokens: i * 10, costUsd: i }) }),
        }),
      ),
    );

    const predecessors = results.map((r, k) => {
      const own = calls[k]!;
      return r.reset !== undefined ? r.reset.fromCostUsd : own - (r.delta['opus']?.costUsd ?? 0);
    });
    expect(new Set(predecessors).size).toBe(calls.length);
    const byPredecessor = new Map(predecessors.map((p, k) => [p, calls[k]!]));
    const chain: number[] = [];
    for (
      let at = 0, next = byPredecessor.get(at);
      next !== undefined;
      next = byPredecessor.get(at)
    ) {
      chain.push(next);
      at = next;
    }
    expect(chain).toHaveLength(calls.length);

    const returned = results.reduce((sum, r) => sum + (r.delta['opus']?.costUsd ?? 0), 0);
    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBeCloseTo(returned, 10);
  });

  it('直列に増える累積なら、合計は最後の累積と一致する（呼んだ順に届く条件下の約束）', async () => {
    for (let i = 1; i <= 10; i++) {
      await record({
        managerId: 'mgr-1',
        date: '2026-08-14',
        at: `2026-08-14T10:00:${String(i).padStart(2, '0')}.000Z`,
        snapshot: snapshot({ opus: totals({ outputTokens: i * 10, costUsd: i }) }),
      });
    }
    const { rows } = await store.aggregate({});
    expect(rows[0]?.totals.costUsd).toBe(10);
    expect(rows[0]?.totals.outputTokens).toBe(100);
  });
});

describe('層と場所の軸（誰が・どこで使ったか）', () => {
  it('同じ日・同じ actor・同じモデルでも、層が違えば別の行になる', async () => {
    await record({
      layer: 'manager',
      managerId: 'same-id',
      date: '2026-08-19',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 2 }) }),
    });
    await record({
      layer: 'clone',
      managerId: 'same-id',
      date: '2026-08-19',
      at: '2026-08-19T10:00:01.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 5 }) }),
    });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(2);
    expect(
      rows
        .map((r) => ({ layer: r.layer, costUsd: r.totals.costUsd }))
        .sort((a, b) => a.costUsd - b.costUsd),
    ).toEqual([
      { layer: 'manager', costUsd: 2 },
      { layer: 'clone', costUsd: 5 },
    ]);
  });

  it('同じ日・同じ actor・同じモデルでも、場所が違えば別の行になる', async () => {
    await record({
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      date: '2026-08-19',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: snapshot({ fable: totals({ costUsd: 1 }) }),
    });
    await record({
      layer: 'clone',
      site: 'distill',
      accumulation: 'oneshot',
      managerId: 'clone',
      date: '2026-08-19',
      at: '2026-08-19T10:00:01.000Z',
      snapshot: snapshot({ fable: totals({ costUsd: 0.25 }) }),
    });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.site, r.totals.costUsd]).sort()).toEqual([
      ['distill', 0.25],
      ['session', 1],
    ]);
  });

  it('同じ manager 層でも、site=peer は session と別の行になり、site で絞れる（#486 S7）', async () => {
    await record({
      layer: 'manager',
      managerId: 'mgr-1',
      date: '2026-08-19',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 3 }) }),
    });
    await record({
      layer: 'manager',
      site: 'peer',
      accumulation: 'oneshot',
      managerId: 'mgr-1',
      date: '2026-08-19',
      at: '2026-08-19T10:00:01.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 0.5 }) }),
    });

    const all = await store.aggregate({});
    expect(all.rows.map((r) => [r.layer, r.site, r.totals.costUsd]).sort()).toEqual([
      ['manager', 'peer', 0.5],
      ['manager', 'session', 3],
    ]);
    const peer = await store.aggregate({ site: 'peer' });
    expect(peer.rows.map((r) => r.totals.costUsd)).toEqual([0.5]);
    const session = await store.aggregate({ site: 'session' });
    expect(session.rows.map((r) => r.totals.costUsd)).toEqual([3]);
  });

  it('層をまたいだ累積の基準が混ざらない（同じ actor id でも別の主体）', async () => {
    await record({
      layer: 'manager',
      managerId: 'same-id',
      date: '2026-08-19',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 10 }) }),
    });
    await record({
      layer: 'clone',
      managerId: 'same-id',
      date: '2026-08-19',
      at: '2026-08-19T10:00:01.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 4 }) }),
    });

    const clone = await store.baseline('clone', 'same-id');
    const manager = await store.baseline('manager', 'same-id');
    expect(clone?.models.opus?.costUsd).toBe(4);
    expect(manager?.models.opus?.costUsd).toBe(10);

    const { rows } = await store.aggregate({ layer: 'clone' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBe(4);
  });

  it('oneshot は基準を持たず、毎回の全量を積む（高くついた回が目減りしない）', async () => {
    const distill = {
      layer: 'clone' as const,
      site: 'distill' as const,
      accumulation: 'oneshot' as const,
      managerId: 'clone',
      date: '2026-08-19',
    };
    await record({
      ...distill,
      at: '2026-08-19T10:00:00.000Z',
      snapshot: snapshot({ fable: totals({ costUsd: 0.05 }) }),
    });
    await record({
      ...distill,
      at: '2026-08-19T11:00:00.000Z',
      snapshot: snapshot({ fable: totals({ costUsd: 0.08 }) }),
    });

    const { rows } = await store.aggregate({ site: 'distill' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBeCloseTo(0.13, 10);
  });

  it('oneshot は基準を書かない（比べる相手がそもそも無い）', async () => {
    const fold = await record({
      layer: 'clone',
      site: 'distill',
      accumulation: 'oneshot',
      managerId: 'clone',
      date: '2026-08-19',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: snapshot({ fable: totals({ costUsd: 0.05 }) }),
    });

    expect(fold.baseline).toBeNull();
    expect(await store.baseline('clone', 'clone')).toBeNull();
  });

  it('layer と site で絞り込める', async () => {
    await record({
      layer: 'manager',
      managerId: 'mgr-1',
      date: '2026-08-19',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 3 }) }),
    });
    await record({
      layer: 'clone',
      managerId: 'clone',
      date: '2026-08-19',
      at: '2026-08-19T10:00:01.000Z',
      snapshot: snapshot({ fable: totals({ costUsd: 1 }) }),
    });
    await record({
      layer: 'clone',
      site: 'distill',
      accumulation: 'oneshot',
      managerId: 'clone',
      date: '2026-08-19',
      at: '2026-08-19T10:00:02.000Z',
      snapshot: snapshot({ fable: totals({ costUsd: 0.5 }) }),
    });

    expect((await store.aggregate({ layer: 'clone' })).rows).toHaveLength(2);
    expect((await store.aggregate({ layer: 'manager' })).rows).toHaveLength(1);
    expect((await store.aggregate({ site: 'distill' })).rows).toHaveLength(1);
    const both = await store.aggregate({ layer: 'clone', site: 'session' });
    expect(both.rows).toHaveLength(1);
    expect(both.rows[0]?.totals.costUsd).toBe(1);
  });
});

describe('層の軸が始まった時刻（既定値と観測を混ぜない）', () => {
  it('1件も無ければ layersSince は null、beforeLayers は真', async () => {
    const aggregate = await store.aggregate({});
    expect(aggregate.layersSince).toBeNull();
    expect(aggregate.beforeLayers).toBe(true);
  });

  it('layersSince は最初の record でだけ入り、以後は上書きしない', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-19',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });
    await record({
      managerId: 'mgr-2',
      date: '2026-08-20',
      at: '2026-08-20T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });

    const aggregate = await store.aggregate({});
    expect(aggregate.layersSince).toBe('2026-08-19T10:00:00.000Z');
    expect(aggregate.since).toBe('2026-08-19T10:00:00.000Z');
  });

  it('層の軸の始点より前を照会したら beforeLayers: true になる', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-19',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });

    expect((await store.aggregate({ from: '2026-08-19' })).beforeLayers).toBe(false);
    expect((await store.aggregate({ from: '2026-08-18' })).beforeLayers).toBe(true);
    expect((await store.aggregate({})).beforeLayers).toBe(true);
  });
});

// 空の DB から始めない: 既存の基準が引けなくなる（二重計上）退行と、層の既定値が観測に見える退行は、層の列が無い状態のスキーマを手で作ってから migrate を当てないと捕まらないため。
describe('既にある DB への移行（層の列が無い状態から）', () => {
  const LEGACY = [
    `create table if not exists usage_daily (
       date text not null,
       manager_id text not null,
       model text not null,
       input_tokens bigint not null default 0,
       output_tokens bigint not null default 0,
       cache_read_input_tokens bigint not null default 0,
       cache_creation_input_tokens bigint not null default 0,
       web_search_requests bigint not null default 0,
       cost_usd double precision not null default 0,
       updated_at timestamptz not null,
       primary key (date, manager_id, model)
     )`,
    `create table if not exists usage_baseline (
       manager_id text primary key,
       session_id text,
       models jsonb not null,
       updated_at timestamptz not null,
       resets integer not null default 0,
       last_reset_at timestamptz
     )`,
    `create table if not exists usage_ledger (
       id text primary key,
       started_at timestamptz not null
     )`,
  ];

  let legacyClient: TestDbHandle;
  let legacyDb: Db;

  beforeEach(async () => {
    ({ client: legacyClient, db: legacyDb } = await createEmptyTestDb());
    for (const statement of LEGACY) {
      await legacyDb.execute(sql.raw(statement));
    }
    await legacyDb.execute(
      sql.raw(`insert into usage_daily (date, manager_id, model, cost_usd, updated_at)
               values ('2026-08-01', 'mgr-old', 'claude-opus-5', 12.5, '2026-08-01T10:00:00Z')`),
    );
    await legacyDb.execute(
      sql.raw(`insert into usage_baseline (manager_id, session_id, models, updated_at)
               values ('mgr-old', 'sess-old',
                       '{"claude-opus-5":{"inputTokens":0,"outputTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"webSearchRequests":0,"costUsd":12.5}}',
                       '2026-08-01T10:00:00Z')`),
    );
    await legacyDb.execute(
      sql.raw(`insert into usage_ledger (id, started_at)
               values ('default', '2026-08-01T09:00:00Z')`),
    );
  });

  afterEach(async () => {
    await legacyClient.close();
  });

  it('既にある行は manager / session になる（既定は既存の行にとって真である）', async () => {
    await migrate(legacyDb);
    const legacyStore = new PgUsageStore(legacyDb);

    const { rows } = await legacyStore.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.layer).toBe('manager');
    expect(rows[0]?.site).toBe('session');
    expect(rows[0]?.totals.costUsd).toBe(12.5);
  });

  it('既にある基準がそのまま引ける（次の1回で二重計上しない）', async () => {
    await migrate(legacyDb);
    const legacyStore = new PgUsageStore(legacyDb);

    const baseline = await legacyStore.baseline('manager', 'mgr-old');
    expect(baseline?.models['claude-opus-5']?.costUsd).toBe(12.5);

    await legacyStore.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-old',
      date: '2026-08-01',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: {
        sessionId: 'sess-old',
        models: { 'claude-opus-5': totals({ costUsd: 13 }) },
      },
    });

    const { rows } = await legacyStore.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBeCloseTo(13, 10);
  });

  it('台帳の始点は動かさず、層の軸の始点だけが後から入る', async () => {
    await migrate(legacyDb);
    const legacyStore = new PgUsageStore(legacyDb);

    // 層の軸の始点を台帳の始点と同じ値で埋めない: 層を足す前の期間の既定値が観測として読めるようになるため。
    const before = await legacyStore.aggregate({ from: '2026-08-01' });
    expect(before.since).toBe('2026-08-01T09:00:00.000Z');
    expect(before.layersSince).toBeNull();
    expect(before.beforeLayers).toBe(true);

    await legacyStore.record({
      layer: 'clone',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'clone',
      date: '2026-08-19',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: { models: { fable: totals({ costUsd: 0.5 }) } },
    });

    const after = await legacyStore.aggregate({ from: '2026-08-19' });
    expect(after.since).toBe('2026-08-01T09:00:00.000Z');
    expect(after.layersSince).toBe('2026-08-19T10:00:00.000Z');
    expect(after.beforeLayers).toBe(false);
    expect((await legacyStore.aggregate({ from: '2026-08-01' })).beforeLayers).toBe(true);
  });

  it('移行後は同じ actor・日・モデルで層の違う行が2つ立てられる（古い3列の鍵が外れている）', async () => {
    await migrate(legacyDb);
    const legacyStore = new PgUsageStore(legacyDb);

    await legacyStore.record({
      layer: 'clone',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-old',
      date: '2026-08-01',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: { models: { 'claude-opus-5': totals({ costUsd: 1 }) } },
    });

    const { rows } = await legacyStore.aggregate({});
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.layer).sort()).toEqual(['clone', 'manager']);
  });

  it('migrate を2回当てても落ちない（鍵の差し替えが冪等である）', async () => {
    await migrate(legacyDb);
    await migrate(legacyDb);
    await migrate(legacyDb);

    const legacyStore = new PgUsageStore(legacyDb);
    const { rows } = await legacyStore.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.layer).toBe('manager');
  });
});

describe('認証トークンの軸（どの区間がどのトークンだったか。#393 受け入れ基準6）', () => {
  function put(over: { at: string; costUsd: number; tokenId?: string; date?: string }) {
    return store.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'oneshot',
      managerId: 'mgr-1',
      date: over.date ?? '2026-08-25',
      at: over.at,
      snapshot: snapshot({ opus: totals({ costUsd: over.costUsd }) }),
      ...(over.tokenId === undefined ? {} : { tokenId: over.tokenId }),
    });
  }

  it('同じ日・同じ actor・同じモデル・同じ層でも、トークンが違えば別の行になる', async () => {
    await put({ at: '2026-08-25T10:00:00.000Z', costUsd: 1, tokenId: 'tok-a' });
    await put({ at: '2026-08-25T11:00:00.000Z', costUsd: 2, tokenId: 'tok-b' });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.tokenId, row.totals.costUsd])).toEqual([
      ['tok-a', 1],
      ['tok-b', 2],
    ]);
  });

  it('帰属の無い行を2回積むと足し込まれる（空文字が鍵として効いている）', async () => {
    // `token_id` を null 許容にしない: 一意索引が null どうしを重複と見なさず、record のたびに新しい行が挿さるため。
    await put({ at: '2026-08-25T10:00:00.000Z', costUsd: 1 });
    await put({ at: '2026-08-25T11:00:00.000Z', costUsd: 1 });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBe(2);
    expect(rows[0]?.tokenId).toBeUndefined();
  });

  it('帰属の無い行は最後に並ぶ（空文字の昇順で先頭に来ない）', async () => {
    await put({ at: '2026-08-25T10:00:00.000Z', costUsd: 1 });
    await put({ at: '2026-08-25T11:00:00.000Z', costUsd: 2, tokenId: 'tok-a' });

    const { rows } = await store.aggregate({});
    expect(rows.map((row) => row.tokenId)).toEqual(['tok-a', undefined]);
  });

  it('tokenId で絞り込める', async () => {
    await put({ at: '2026-08-25T10:00:00.000Z', costUsd: 1, tokenId: 'tok-a' });
    await put({ at: '2026-08-25T10:00:00.000Z', costUsd: 2, tokenId: 'tok-b' });

    const only = await store.aggregate({ tokenId: 'tok-b' });
    expect(only.rows).toHaveLength(1);
    expect(only.rows[0]?.tokenId).toBe('tok-b');
  });

  it('tokensSince は帰属が付いた record でだけ入る（プールを使わない器では最後まで null）', async () => {
    await put({ at: '2026-08-25T10:00:00.000Z', costUsd: 1 });

    const before = await store.aggregate({});
    expect(before.since).toBe('2026-08-25T10:00:00.000Z');
    expect(before.layersSince).toBe('2026-08-25T10:00:00.000Z');
    expect(before.tokensSince).toBeNull();
    expect(before.beforeTokens).toBe(true);

    await put({ at: '2026-08-26T10:00:00.000Z', costUsd: 1, tokenId: 'tok-a', date: '2026-08-26' });

    const after = await store.aggregate({});
    expect(after.tokensSince).toBe('2026-08-26T10:00:00.000Z');
    expect(after.since).toBe('2026-08-25T10:00:00.000Z');
  });

  it('tokensSince は最初の帰属付き record でだけ入り、以後は上書きしない', async () => {
    await put({ at: '2026-08-25T10:00:00.000Z', costUsd: 1, tokenId: 'tok-a' });
    await put({ at: '2026-08-26T10:00:00.000Z', costUsd: 1, tokenId: 'tok-b', date: '2026-08-26' });

    expect((await store.aggregate({})).tokensSince).toBe('2026-08-25T10:00:00.000Z');
  });

  it('トークンの軸の始点より前を照会したら beforeTokens: true になる', async () => {
    await put({ at: '2026-08-25T10:00:00.000Z', costUsd: 1, tokenId: 'tok-a' });

    expect((await store.aggregate({ from: '2026-08-25' })).beforeTokens).toBe(false);
    expect((await store.aggregate({ from: '2026-08-24' })).beforeTokens).toBe(true);
    expect((await store.aggregate({})).beforeTokens).toBe(true);
  });
});

describe('回数の軸（起きた回数。model を鍵に持たない別会計）', () => {
  it('⭐ 2つのモデルが増えた1回の record で、usage_daily は2行・回数は1', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      snapshot: snapshot({
        opus: totals({ costUsd: 1 }),
        sonnet: totals({ costUsd: 0.1 }),
      }),
    });

    const { rows, turnRows } = await store.aggregate({});
    expect(rows).toHaveLength(2);
    expect(turnRows).toHaveLength(1);
    expect(turnRows[0]?.turns).toBe(1);
  });

  it('2回 record したら回数は2（足し込みであって上書きではない）', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });
    await record({
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T11:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 2 }) }),
    });

    const { turnRows } = await store.aggregate({});
    expect(turnRows).toHaveLength(1);
    expect(turnRows[0]?.turns).toBe(2);
  });

  it('増分が空の record（同じ累積スナップショットの再送）は数えない', async () => {
    const input = {
      managerId: 'mgr-1',
      date: '2026-08-25',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    };
    await record({ ...input, at: '2026-08-25T10:00:00.000Z' });
    await record({ ...input, at: '2026-08-25T10:00:05.000Z' });

    const { rows, turnRows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBe(1);
    expect(turnRows).toHaveLength(1);
    expect(turnRows[0]?.turns).toBe(1);
  });

  it('日・actor・layer・site・tokenId のどれか1つが違えば別の turnRow になる（5軸それぞれを1つずつずらす）', async () => {
    const base = {
      accumulation: 'oneshot' as const,
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    };
    await store.record({
      ...base,
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      tokenId: 'tok-a',
    });
    await store.record({
      ...base,
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      date: '2026-08-26',
      at: '2026-08-26T10:00:00.000Z',
      tokenId: 'tok-a',
    });
    await store.record({
      ...base,
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-2',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      tokenId: 'tok-a',
    });
    await store.record({
      ...base,
      layer: 'clone',
      site: 'session',
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      tokenId: 'tok-a',
    });
    await store.record({
      ...base,
      layer: 'manager',
      site: 'distill',
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      tokenId: 'tok-a',
    });
    await store.record({
      ...base,
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      tokenId: 'tok-b',
    });

    const { turnRows } = await store.aggregate({});
    expect(turnRows).toHaveLength(6);
    expect(turnRows.every((row) => row.turns === 1)).toBe(true);
  });

  it('turnsSince は最初に数えた回で入り、以後の record で上書きされない。増分が空の回では始まらない', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T09:00:00.000Z',
      snapshot: snapshot({ opus: totals({}) }),
    });
    const empty = await store.aggregate({});
    expect(empty.since).toBe('2026-08-25T09:00:00.000Z');
    expect(empty.layersSince).toBe('2026-08-25T09:00:00.000Z');
    expect(empty.turnRows).toEqual([]);
    expect(empty.turnsSince).toBeNull();

    await record({
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });
    const first = await store.aggregate({});
    expect(first.turnsSince).toBe('2026-08-25T10:00:00.000Z');

    await record({
      managerId: 'mgr-1',
      date: '2026-08-26',
      at: '2026-08-26T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 2 }) }),
    });
    const second = await store.aggregate({});
    expect(second.turnsSince).toBe('2026-08-25T10:00:00.000Z');
  });

  it('回数の軸の始点より前を照会したら beforeTurns: true になる', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });

    expect((await store.aggregate({ from: '2026-08-25' })).beforeTurns).toBe(false);
    expect((await store.aggregate({ from: '2026-08-24' })).beforeTurns).toBe(true);
    expect((await store.aggregate({})).beforeTurns).toBe(true);
  });

  it('照会の絞り（from/to/managerId/layer/site/tokenId）が turnRows にも同じく効く', async () => {
    await store.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'oneshot',
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
      tokenId: 'tok-a',
    });
    await store.record({
      layer: 'clone',
      site: 'distill',
      accumulation: 'oneshot',
      managerId: 'mgr-2',
      date: '2026-08-26',
      at: '2026-08-26T10:00:00.000Z',
      snapshot: snapshot({ sonnet: totals({ costUsd: 2 }) }),
      tokenId: 'tok-b',
    });

    expect((await store.aggregate({ from: '2026-08-26' })).turnRows).toHaveLength(1);
    expect((await store.aggregate({ to: '2026-08-25' })).turnRows).toHaveLength(1);
    expect((await store.aggregate({ managerId: 'mgr-1' })).turnRows).toHaveLength(1);
    expect((await store.aggregate({ layer: 'clone' })).turnRows).toHaveLength(1);
    expect((await store.aggregate({ site: 'distill' })).turnRows).toHaveLength(1);
    expect((await store.aggregate({ tokenId: 'tok-a' })).turnRows).toHaveLength(1);
  });

  it('不変条件: 数えられた turnRow の5軸の鍵は、必ず同じ照会結果の費用行のどれかに射影される', async () => {
    await store.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'oneshot',
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }), sonnet: totals({ costUsd: 0.1 }) }),
      tokenId: 'tok-a',
    });
    await store.record({
      layer: 'clone',
      site: 'distill',
      accumulation: 'oneshot',
      managerId: 'mgr-2',
      date: '2026-08-26',
      at: '2026-08-26T10:00:00.000Z',
      snapshot: snapshot({ sonnet: totals({ costUsd: 2 }) }),
    });

    const { rows, turnRows } = await store.aggregate({});
    expect(turnRows.length).toBeGreaterThan(0);
    for (const turn of turnRows) {
      const projected = rows.some(
        (row) =>
          row.date === turn.date &&
          row.managerId === turn.managerId &&
          row.layer === turn.layer &&
          row.site === turn.site &&
          row.tokenId === turn.tokenId,
      );
      expect(projected).toBe(true);
    }
  });

  it('費用の行が在って回数の記録が無い状態（既にある DB を模す）で、aggregate は turnRows: [] / turnsSince: null を返す（0の行を作らない）', async () => {
    await db.execute(
      sql.raw(`insert into usage_daily (date, manager_id, model, layer, site, cost_usd, updated_at)
               values ('2026-08-25', 'mgr-old', 'claude-opus-5', 'manager', 'session', 1, '2026-08-25T10:00:00Z')`),
    );
    await db.execute(
      sql.raw(`insert into usage_ledger (id, started_at, layered_at)
               values ('default', '2026-08-25T10:00:00Z', '2026-08-25T10:00:00Z')`),
    );

    const aggregate = await store.aggregate({});
    expect(aggregate.rows).toHaveLength(1);
    expect(aggregate.turnRows).toEqual([]);
    expect(aggregate.turnsSince).toBeNull();
    expect(aggregate.beforeTurns).toBe(true);
  });
});

describe('起動を2回通す（usage_turns。新規テーブルなので鍵の差し替えは無い）', () => {
  it('回数を記録してから2周目を通しても落ちず、行が消えない', async () => {
    await store.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'oneshot',
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });

    await migrate(db);
    await migrate(db);

    const { turnRows } = await store.aggregate({});
    expect(turnRows).toHaveLength(1);
    expect(turnRows[0]?.turns).toBe(1);
  });
});

// 空の DB から始めない: 新しい鍵を旧名のまま作る形は、空の DB なら6列の索引が作られて通り、5列の既存索引が名前で一致して no-op になる罠を踏めないため。
describe('既にある DB への移行（層の列は在るがトークンの列が無い状態から）', () => {
  const LAYERED = [
    `create table if not exists usage_daily (
       date text not null,
       manager_id text not null,
       model text not null,
       input_tokens bigint not null default 0,
       output_tokens bigint not null default 0,
       cache_read_input_tokens bigint not null default 0,
       cache_creation_input_tokens bigint not null default 0,
       web_search_requests bigint not null default 0,
       cost_usd double precision not null default 0,
       layer text not null default 'manager',
       site text not null default 'session',
       updated_at timestamptz not null
     )`,
    `create unique index if not exists usage_daily_key_idx
       on usage_daily (date, manager_id, model, layer, site)`,
    `create table if not exists usage_baseline (
       manager_id text not null,
       layer text not null default 'manager',
       session_id text,
       models jsonb not null,
       updated_at timestamptz not null,
       resets integer not null default 0,
       last_reset_at timestamptz
     )`,
    `create unique index if not exists usage_baseline_key_idx
       on usage_baseline (layer, manager_id)`,
    `create table if not exists usage_ledger (
       id text primary key,
       started_at timestamptz not null,
       layered_at timestamptz
     )`,
  ];

  let layeredClient: TestDbHandle;
  let layeredDb: Db;

  beforeEach(async () => {
    ({ client: layeredClient, db: layeredDb } = await createEmptyTestDb());
    for (const statement of LAYERED) {
      await layeredDb.execute(sql.raw(statement));
    }
    await layeredDb.execute(
      sql.raw(`insert into usage_daily (date, manager_id, model, layer, site, cost_usd, updated_at)
               values ('2026-08-01', 'mgr-old', 'claude-opus-5', 'manager', 'session', 12.5, '2026-08-01T10:00:00Z')`),
    );
    await layeredDb.execute(
      sql.raw(`insert into usage_ledger (id, started_at, layered_at)
               values ('default', '2026-08-01T09:00:00Z', '2026-08-19T09:00:00Z')`),
    );
  });

  afterEach(async () => {
    await layeredClient.close();
  });

  it('移行後は同じ日・actor・モデル・層でトークンの違う行が2つ立てられる（旧名の5列索引が外れている）', async () => {
    await migrate(layeredDb);
    const layeredStore = new PgUsageStore(layeredDb);

    for (const tokenId of ['tok-a', 'tok-b']) {
      await layeredStore.record({
        layer: 'manager',
        site: 'session',
        accumulation: 'oneshot',
        managerId: 'mgr-new',
        date: '2026-08-25',
        at: '2026-08-25T10:00:00.000Z',
        snapshot: { models: { 'claude-opus-5': totals({ costUsd: 1 }) } },
        tokenId,
      });
    }

    const { rows } = await layeredStore.aggregate({ managerId: 'mgr-new' });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.tokenId)).toEqual(['tok-a', 'tok-b']);
  });

  it('旧名の索引が実際に消え、新しい名前の索引が在る（no-op で通していない）', async () => {
    await migrate(layeredDb);

    const result = (await layeredDb.execute(
      sql.raw(`select indexname from pg_indexes where tablename = 'usage_daily'`),
    )) as { rows: Array<{ indexname: string }> };
    const names = result.rows.map((row) => row.indexname).sort();
    // 行が2つ立つことだけで済ませない: 旧索引が消えたことでも新索引が在ることでも説明できてしまうため、名前で直接見る。
    expect(names).toContain('usage_daily_token_key_idx');
    expect(names).not.toContain('usage_daily_key_idx');
  });

  it('既にある行はトークンの帰属を持たない（既定を観測として売らない）', async () => {
    await migrate(layeredDb);
    const layeredStore = new PgUsageStore(layeredDb);

    const { rows, tokensSince, beforeTokens } = await layeredStore.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenId).toBeUndefined();
    expect(rows[0]?.totals.costUsd).toBe(12.5);
    expect(tokensSince).toBeNull();
    expect(beforeTokens).toBe(true);
  });

  it('台帳と層の始点は動かさず、トークンの軸の始点だけが後から入る', async () => {
    await migrate(layeredDb);
    const layeredStore = new PgUsageStore(layeredDb);

    await layeredStore.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'oneshot',
      managerId: 'mgr-new',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      snapshot: { models: { 'claude-opus-5': totals({ costUsd: 1 }) } },
      tokenId: 'tok-a',
    });

    const aggregate = await layeredStore.aggregate({});
    expect(aggregate.since).toBe('2026-08-01T09:00:00.000Z');
    expect(aggregate.layersSince).toBe('2026-08-19T09:00:00.000Z');
    expect(aggregate.tokensSince).toBe('2026-08-25T10:00:00.000Z');
  });

  it('migrate を2回当てても落ちない（鍵の差し替えが冪等である）', async () => {
    await migrate(layeredDb);
    await migrate(layeredDb);
    await migrate(layeredDb);

    const layeredStore = new PgUsageStore(layeredDb);
    const { rows } = await layeredStore.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenId).toBeUndefined();
  });
});

// 2周目を通すだけにしない: 行が1つなら5列でも一意で create が通ってしまうため、新しい鍵が許して古い鍵が拒む行を挟む。
describe('起動を2回通す（`migrate` の周回が、古い鍵を作りに戻らない）', () => {
  async function putTwoTokens(target: PgUsageStore): Promise<void> {
    for (const tokenId of ['', 'tok-a']) {
      await target.record({
        layer: 'manager',
        site: 'session',
        accumulation: 'oneshot',
        managerId: 'mgr-1',
        date: '2026-08-25',
        at: '2026-08-25T10:00:00.000Z',
        snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
        tokenId,
      });
    }
  }

  it('空の DB から: 記録してから2周目を通しても落ちず、行が消えない', async () => {
    await putTwoTokens(store);
    expect((await store.aggregate({})).rows).toHaveLength(2);

    await migrate(db);
    await migrate(db);

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.tokenId ?? '').sort()).toEqual(['', 'tok-a']);
  });

  it('5列の鍵が既に在る DB から: 移行して記録してから2周目を通しても落ちない', async () => {
    const { client: legacyClient, db: legacyDb } = await createEmptyTestDb();
    try {
      await legacyDb.execute(
        sql.raw(`create table if not exists usage_daily (
           date text not null,
           manager_id text not null,
           model text not null,
           input_tokens bigint not null default 0,
           output_tokens bigint not null default 0,
           cache_read_input_tokens bigint not null default 0,
           cache_creation_input_tokens bigint not null default 0,
           web_search_requests bigint not null default 0,
           cost_usd double precision not null default 0,
           layer text not null default 'manager',
           site text not null default 'session',
           updated_at timestamptz not null
         )`),
      );
      await legacyDb.execute(
        sql.raw(`create unique index if not exists usage_daily_key_idx
                   on usage_daily (date, manager_id, model, layer, site)`),
      );

      await migrate(legacyDb);
      await putTwoTokens(new PgUsageStore(legacyDb));
      await migrate(legacyDb);

      const names = (
        (await legacyDb.execute(
          sql.raw(`select indexname from pg_indexes where tablename = 'usage_daily'`),
        )) as { rows: Array<{ indexname: string }> }
      ).rows.map((row) => row.indexname);
      expect(names).not.toContain('usage_daily_key_idx');
      expect(names).toContain('usage_daily_token_key_idx');
      expect((await new PgUsageStore(legacyDb).aggregate({})).rows).toHaveLength(2);
    } finally {
      await legacyClient.close();
    }
  });
});

describe('PgUsageStore.recordedManagerIds', () => {
  it('1件も record していなければ空集合', async () => {
    expect(await store.recordedManagerIds()).toEqual(new Set());
  });

  it('狭い範囲を aggregate しても、それより古い日付の行の managerId は消えない', async () => {
    await record({
      managerId: 'mgr-old',
      date: '2026-05-01',
      at: '2026-05-01T00:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });

    const narrow = await store.aggregate({ from: '2026-08-01', to: '2026-08-31' });
    expect(narrow.rows).toHaveLength(0);

    expect(await store.recordedManagerIds()).toEqual(new Set(['mgr-old']));
  });

  it('基準だけが在って行が無い managerId は数えない（全部ゼロの最初のスナップショット）', async () => {
    const result = await record({
      managerId: 'mgr-baseline-only',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({}) }),
    });
    expect(result.delta).toEqual({});
    expect(result.baseline).not.toBeNull();

    expect(await store.baseline('manager', 'mgr-baseline-only')).not.toBeNull();
    expect((await store.aggregate({})).rows).toHaveLength(0);
    expect(await store.recordedManagerIds()).toEqual(new Set());
  });

  it('行が在って基準が無い managerId は数える（oneshot）', async () => {
    await store.record({
      layer: 'clone',
      site: 'distill',
      accumulation: 'oneshot',
      managerId: 'clone',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 0.5 }) }),
    });

    expect(await store.baseline('clone', 'clone')).toBeNull();
    expect(await store.recordedManagerIds()).toEqual(new Set(['clone']));
  });

  it('複数の managerId・複数の行があっても、集合として一意にまとまる', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });
    await record({
      managerId: 'mgr-1',
      date: '2026-08-15',
      at: '2026-08-15T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 2 }) }),
    });
    await record({
      managerId: 'mgr-2',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ sonnet: totals({ costUsd: 3 }) }),
    });

    expect(await store.recordedManagerIds()).toEqual(new Set(['mgr-1', 'mgr-2']));
  });
});

describe('PgUsageStore の鍵列の NUL（issue #2927。3実装で同じことを測る）', () => {
  it('鍵列の NUL は断らず、落として残す', async () => {
    await verifyUsageNulContract(store);
  });
});

describe('PgUsageStore の runner ごとの最後の累積（Issue #3022 仮説1。3実装で同じことを測る）', () => {
  it('古い runner の累積は、その runner 自身の前回との差だけを積む', async () => {
    await verifyUsageRunnerContract(store);
  });
});

describe('PgUsageStore: runner ごとの最後の累積の列は、旧スキーマから後方互換で足される（Issue #3022 仮説1）', () => {
  let legacyClient: TestDbHandle;
  let legacyDb: Db;

  beforeEach(async () => {
    ({ client: legacyClient, db: legacyDb } = await createEmptyTestDb());
    await migrate(legacyDb);
    await legacyDb.execute(sql.raw('alter table usage_baseline drop column by_runner'));
    await legacyDb.execute(
      sql.raw(`insert into usage_baseline (manager_id, session_id, models, updated_at)
               values ('mgr-old', 'sess-old',
                       '{"claude-opus-5":{"inputTokens":0,"outputTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"webSearchRequests":0,"costUsd":12.5}}',
                       '2026-08-01T10:00:00Z')`),
    );
  });

  afterEach(async () => {
    await legacyClient.close();
  });

  it('古い行は控え無し（覚えていない）として読まれ、古い runner の累積は積まれない。現役の記録の後は差で積まれる', async () => {
    await migrate(legacyDb);
    await migrate(legacyDb);
    const legacyStore = new PgUsageStore(legacyDb);
    const baseline = await legacyStore.baseline('manager', 'mgr-old');
    expect(baseline?.byRunner).toBeUndefined();
    expect(baseline?.models['claude-opus-5']?.costUsd).toBe(12.5);

    const base = {
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-old',
      date: '2026-10-06',
      accumulation: 'cumulative',
    } as const;
    const costOf = async () =>
      (await legacyStore.aggregate({ managerId: 'mgr-old' })).rows.reduce(
        (sum, row) => sum + row.totals.costUsd,
        0,
      );
    const at = (n: number) => `2026-10-06T00:00:0${String(n)}.000Z`;

    const first = await legacyStore.record({
      ...base,
      at: at(1),
      snapshot: snapshot({ 'claude-opus-5': totals({ costUsd: 20 }) }),
      runner: { id: 'runner-a', superseded: true },
    });
    expect(first.skipped).toEqual({ reason: 'unknown-runner' });
    expect(await costOf()).toBe(0);

    await legacyStore.record({
      ...base,
      at: at(2),
      snapshot: snapshot({ 'claude-opus-5': totals({ costUsd: 13 }) }),
      runner: { id: 'runner-b', superseded: false },
    });
    const second = await legacyStore.record({
      ...base,
      at: at(3),
      snapshot: snapshot({ 'claude-opus-5': totals({ costUsd: 22 }) }),
      runner: { id: 'runner-a', superseded: true },
    });
    expect(second.delta['claude-opus-5']?.costUsd).toBe(2);
  });
});

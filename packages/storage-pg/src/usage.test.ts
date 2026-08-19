import {
  USAGE_ESTIMATE_NOTICE,
  ZERO_USAGE,
  type UsageAccumulation,
  type UsageLayer,
  type UsageSite,
  type UsageSnapshot,
  type UsageTotals,
} from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { migrate } from './migrate.js';
import { PgUsageStore } from './usage.js';

/**
 * pg ドライバの受け入れ確認。
 *
 * **PGlite（インプロセスの実 PostgreSQL）で通す。** 偽の DB では SQL・索引・
 * upsert の冪等性を確かめたことにならない。差分の算術そのものは
 * `foldUsageSnapshot`（`packages/core/src/usage.test.ts`）で確かめ済みなので、
 * ここでは fs 版（`usage.test.ts`）と同じ受け入れ項目を pg 経由で問う。
 */
let client: PGlite;
let db: Db;
let store: PgUsageStore;

function totals(over: Partial<UsageTotals>): UsageTotals {
  return { ...ZERO_USAGE, ...over };
}

function snapshot(models: Record<string, UsageTotals>): UsageSnapshot {
  return { models };
}

/**
 * 既存の受け入れ項目は「マネージャーのセッション本体・累積」の場合を問うもので、
 * その3つを既定として補う薄い包み。**アサーションは1つも変えていない** —
 * 層と場所が入る前と同じことを、同じ強さで問い続ける。
 *
 * 層と場所そのものの保証は下の describe が別に問う（既定に寄りかからないよう、
 * そちらでは毎回明示的に渡す）。
 */
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
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
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
    // bigint 列が number として返ること（文字列連結の退行を検出する）。
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

describe('PgUsageStore の不変条件（record はトランザクションで1操作に閉じる）', () => {
  it('並行に record しても増分が失われない', async () => {
    // 累積スナップショットを模す: 各呼び出しは「その時点までの累積」を運ぶ。
    // トランザクションが直列化していれば、最終合計は最後の累積とちょうど一致する。
    const calls = Array.from({ length: 10 }, (_, i) => i + 1);
    await Promise.all(
      calls.map((i) =>
        record({
          managerId: 'mgr-1',
          date: '2026-08-14',
          at: `2026-08-14T10:00:${String(i).padStart(2, '0')}.000Z`,
          snapshot: snapshot({ opus: totals({ outputTokens: i * 10, costUsd: i }) }),
        }),
      ),
    );

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBe(10);
    expect(rows[0]?.totals.outputTokens).toBe(100);
  });
});

/**
 * 「誰が・どこで」の軸。**モデル id で層を代用できないことがここの前提である** —
 * `ALTEROID_CLONE_MODEL` を置けばクローンもマネージャーも同じ `model` で並ぶ。
 */
describe('層と場所の軸（誰が・どこで使ったか）', () => {
  it('同じ日・同じ actor・同じモデルでも、層が違えば別の行になる', async () => {
    // 同じ id・同じモデルで層だけが違う2件。層が鍵に入っていなければ、2件目は
    // 1件目へ足し込まれて1行になり、`layer` は先に入った側の値のまま残る
    // ＝ 出力から見分けられない誤帰属になる。
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
      rows.map((r) => ({ layer: r.layer, costUsd: r.totals.costUsd })).sort((a, b) => a.costUsd - b.costUsd),
    ).toEqual([
      { layer: 'manager', costUsd: 2 },
      { layer: 'clone', costUsd: 5 },
    ]);
  });

  it('同じ日・同じ actor・同じモデルでも、場所が違えば別の行になる', async () => {
    // クローンは自分のセッション本体と要約の蒸留の両方で使う。ここが1行に潰れると
    // 「要約のたびにいくら払っているか」が本体の分に混ざって読めなくなる。
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

  it('層をまたいだ累積の基準が混ざらない（同じ actor id でも別の主体）', async () => {
    // 基準の鍵が actor の id だけだと、2つの累積が1つの基準を共有して差分が嘘に
    // なる。ここでは manager 側の累積が clone 側の差分に効かないことを問う。
    await record({
      layer: 'manager',
      managerId: 'same-id',
      date: '2026-08-19',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 10 }) }),
    });
    // clone 側は初回なので、基準が無い＝全量が増分。manager の $10 を基準として
    // 引いてしまえば増分は 0 になり、この行は生まれない。
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
    // **これが `foldOneshotUsage` の存在理由の実験である。** 蒸留のサイドクエリは
    // 毎回新しい `query()` で、その `result` はその1回の総量そのものである。
    // 基準を持たせると 2回目は差の $0.03 しか積まれず、$0.08 の回が黙って縮む。
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
    // 0.05 + 0.08。基準を持っていれば 0.05 + 0.03 = 0.08 になる。
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
    // 台帳の始点も動いていない（別の値として持っていることの確認）。
    expect(aggregate.since).toBe('2026-08-19T10:00:00.000Z');
  });

  it('層の軸の始点より前を照会したら beforeLayers: true になる', async () => {
    await record({
      managerId: 'mgr-1',
      date: '2026-08-19',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });

    // 始点の当日以降を聞いているので、層の内訳は観測である。
    expect((await store.aggregate({ from: '2026-08-19' })).beforeLayers).toBe(false);
    // 前日を含めて聞いているので、その分の層は既定値であって観測ではない。
    expect((await store.aggregate({ from: '2026-08-18' })).beforeLayers).toBe(true);
    // 下限の無い照会は常に前を含みうる。
    expect((await store.aggregate({})).beforeLayers).toBe(true);
  });
});

/**
 * **既にある DB へ当てたときに何が起きるか。**
 *
 * ここは黙って壊れる場所である。本番の台帳には既に55本のマネージャーぶんの行と
 * 基準が入っていて、この移行はその上に当たる。壊れ方は2つあり、どちらも出力からは
 * 正常に見える —
 *
 * 1. **既存の基準が引けなくなる** → 「基準が無い」と読まれ、次の1回で累積の全量が
 *    増分として積まれる ＝ 記録済みの分の二重計上（合計が跳ねるが、跳ねたことは
 *    どこにも出ない）
 * 2. **層の既定値を観測として見せる** → 層を足す前の期間が「クローンは使って
 *    いなかった」と読める
 *
 * だから**層の列が無い状態のスキーマを手で作ってから** migrate を当てて確かめる。
 */
describe('既にある DB への移行（層の列が無い状態から）', () => {
  /** 層の列が入る前のスキーマ。`migrate.ts` から写したもの。 */
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

  let legacyClient: PGlite;
  let legacyDb: Db;

  beforeEach(async () => {
    legacyClient = new PGlite();
    legacyDb = drizzle(legacyClient);
    for (const statement of LEGACY) {
      await legacyDb.execute(sql.raw(statement));
    }
    // 既にある行（マネージャーの分だけ。クローンの分は1バイトも記録されていない）
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

    // 基準が引けること自体
    const baseline = await legacyStore.baseline('manager', 'mgr-old');
    expect(baseline?.models['claude-opus-5']?.costUsd).toBe(12.5);

    // そして「差分だけ積む」が続くこと。基準が引けなければ全量の $13.0 が積まれ、
    // 合計は 12.5 + 13.0 = 25.5 へ跳ねる（記録済みの分の二重計上）。
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

    // migrate を当てただけでは層の軸はまだ始まっていない。**ここを台帳の始点と
    // 同じ値で埋めないこと** — 埋めると、層を足す前の期間の既定値が観測として
    // 読めるようになる。
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
    // 台帳の始点は動いていない
    expect(after.since).toBe('2026-08-01T09:00:00.000Z');
    // 層の軸の始点は今回の record で入った
    expect(after.layersSince).toBe('2026-08-19T10:00:00.000Z');
    expect(after.beforeLayers).toBe(false);
    // 層より前を含めて聞けば、内訳は既定値であって観測ではない
    expect((await legacyStore.aggregate({ from: '2026-08-01' })).beforeLayers).toBe(true);
  });

  it('移行後は同じ actor・日・モデルで層の違う行が2つ立てられる（古い3列の鍵が外れている）', async () => {
    await migrate(legacyDb);
    const legacyStore = new PgUsageStore(legacyDb);

    // 古い primary key (date, manager_id, model) が残っていると、この2件目は
    // 一意制約で拒まれるか、on conflict で1件目へ足し込まれる。
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

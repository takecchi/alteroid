import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  USAGE_ESTIMATE_NOTICE,
  ZERO_USAGE,
  type UsageAccumulation,
  type UsageLayer,
  type UsageSite,
  type UsageSnapshot,
  type UsageTotals,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { FsUsageStore } from './usage.js';

/**
 * fs ドライバの受け入れ確認。
 *
 * `store.ts` の契約（読み・畳み・書きを1操作に閉じる、`since` / `beforeLedger` を
 * 必ず返す）を fs 版で確かめる。差分の算術そのものは `foldUsageSnapshot`
 * （`packages/core/src/usage.test.ts`）で確かめ済みなので、ここでは重複しない。
 */
let store: FsUsageStore;

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
  const dir = await mkdtemp(join(tmpdir(), 'alteroid-usage-test-'));
  store = new FsUsageStore(dir);
});

describe('FsUsageStore.record', () => {
  it('同じ累積スナップショットを2回 record しても合計が増えない（二重計上しない）', async () => {
    const input = {
      managerId: 'mgr-1',
      date: '2026-08-14',
      snapshot: snapshot({ opus: totals({ outputTokens: 100, costUsd: 1 }) }),
    };
    await record({ ...input, at: '2026-08-14T10:00:00.000Z' });
    // 再送（同じ result がもう一度届いた、を模す）
    await record({ ...input, at: '2026-08-14T10:00:05.000Z' });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals).toEqual(totals({ outputTokens: 100, costUsd: 1 }));
  });

  it('累積が増えれば差分だけ足し込む', async () => {
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
  });

  it('累積が減っても、記録済みの合計は減らない（新しい累積の全量を足す）', async () => {
    // 累積 $5 まで記録済み → resume で 0 に戻り、次に読めた累積が $3。
    // 実際に使った額は $8 なので、台帳の合計も $8 でなければならない。
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

  it('同じ日にモデルをまたいで積んでも別の行になる', async () => {
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
});

describe('FsUsageStore.aggregate', () => {
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

    // 日で絞る
    const byDate = await store.aggregate({ from: '2026-08-14', to: '2026-08-14' });
    expect(byDate.rows).toHaveLength(2);

    // マネージャーで絞る
    const byManager = await store.aggregate({ managerId: 'mgr-1' });
    expect(byManager.rows.map((r) => r.date).sort()).toEqual(['2026-08-13', '2026-08-14']);

    // モデルは行の属性として区別できる（クエリ軸ではないが、行から引ける）
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

describe('FsUsageStore の不変条件（1操作に閉じる）', () => {
  it('並行に record しても増分が失われない（読み書きが1操作に閉じている）', async () => {
    // 累積スナップショットを模す: 各呼び出しは「その時点までの累積」を運ぶ。
    // 直列化されていれば、最終的な合計は最後の累積とちょうど一致する。
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
    // 累積は単調増加なので、直列化されていれば数え直しは起きず、合計は最大値と一致する。
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
      rows
        .map((r) => ({ layer: r.layer, costUsd: r.totals.costUsd }))
        .sort((a, b) => a.costUsd - b.costUsd),
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
 * **既にある `usage.json` を読んだときに何が起きるか。**
 *
 * pg 側の `alter table … add column … default 'manager'` に対応するのがここである。
 * 壊れ方は3つあり、どれも出力からは正常に見える —
 *
 * 1. **既定無しで読むと台帳が丸ごと読めなくなる**（`usageRowSchema` は層を必須に
 *    している）＝ 既存の記録が消えたのと同じことになる
 * 2. **既存の基準が引けなくなる**（鍵が `actor` から `層 × actor` へ変わった）
 *    → 「基準が無い」と読まれ、次の1回で累積の全量が積まれる ＝ 二重計上
 * 3. **古い鍵と新しい鍵で同じ論理的な1行が2つに割れる**（合計は合うが一覧に
 *    同じものが2つ並ぶ）
 */
describe('既にある usage.json の読み込み（層の列が無い状態から）', () => {
  let dir: string;

  /**
   * 層の列が入る前の鍵の区切り。`usage.ts` の `rowKey` が使っている制御文字で、
   * ソースに素で書くと読めないので明示的に作る。
   */
  const SEP = String.fromCharCode(0);

  /** 層の列が入る前の形の `usage.json` を手で置く。 */
  async function writeLegacy(): Promise<void> {
    const legacy = {
      rows: {
        // 鍵は `date / actor / model` の3つ組だった。
        [['2026-08-01', 'mgr-old', 'claude-opus-5'].join(SEP)]: {
          date: '2026-08-01',
          managerId: 'mgr-old',
          model: 'claude-opus-5',
          totals: totals({ costUsd: 12.5 }),
          updatedAt: '2026-08-01T10:00:00.000Z',
        },
      },
      // 鍵は actor の id そのものだった。
      baselines: {
        'mgr-old': {
          managerId: 'mgr-old',
          sessionId: 'sess-old',
          models: { 'claude-opus-5': totals({ costUsd: 12.5 }) },
          updatedAt: '2026-08-01T10:00:00.000Z',
          resets: 0,
        },
      },
      startedAt: '2026-08-01T09:00:00.000Z',
    };
    await writeFile(join(dir, 'usage.json'), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'alteroid-usage-legacy-'));
    store = new FsUsageStore(dir);
    await writeLegacy();
  });

  it('既にある行を読めて、manager / session になる', async () => {
    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.layer).toBe('manager');
    expect(rows[0]?.site).toBe('session');
    expect(rows[0]?.totals.costUsd).toBe(12.5);
  });

  it('既にある基準がそのまま引ける（次の1回で二重計上しない）', async () => {
    const baseline = await store.baseline('manager', 'mgr-old');
    expect(baseline?.models['claude-opus-5']?.costUsd).toBe(12.5);

    // 基準が引けなければ全量の $13.0 が積まれ、合計は 25.5 へ跳ねる。
    await record({
      managerId: 'mgr-old',
      date: '2026-08-01',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: {
        sessionId: 'sess-old',
        models: { 'claude-opus-5': totals({ costUsd: 13 }) },
      },
    });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBeCloseTo(13, 10);
  });

  it('同じ論理的な1行が古い鍵と新しい鍵で2つに割れない', async () => {
    // 同じ日・同じ actor・同じモデル・同じ層へ足す。鍵を値から引き直していなければ、
    // 古い3つ組の鍵と新しい5つ組の鍵で行が2つ並ぶ。
    await record({
      managerId: 'mgr-old',
      date: '2026-08-01',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: {
        sessionId: 'sess-old',
        models: { 'claude-opus-5': totals({ costUsd: 13 }) },
      },
    });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
  });

  it('台帳の始点は動かさず、層の軸の始点だけが後から入る', async () => {
    const before = await store.aggregate({ from: '2026-08-01' });
    expect(before.since).toBe('2026-08-01T09:00:00.000Z');
    expect(before.layersSince).toBeNull();
    expect(before.beforeLayers).toBe(true);

    await record({
      layer: 'clone',
      managerId: 'clone',
      date: '2026-08-19',
      at: '2026-08-19T10:00:00.000Z',
      snapshot: snapshot({ fable: totals({ costUsd: 0.5 }) }),
    });

    const after = await store.aggregate({ from: '2026-08-19' });
    expect(after.since).toBe('2026-08-01T09:00:00.000Z');
    expect(after.layersSince).toBe('2026-08-19T10:00:00.000Z');
    expect(after.beforeLayers).toBe(false);
    expect((await store.aggregate({ from: '2026-08-01' })).beforeLayers).toBe(true);
  });
});

describe('認証トークンの軸（どの区間がどのトークンだったか。#393 受け入れ基準6）', () => {
  it('同じ日・同じ actor・同じモデル・同じ層でも、トークンが違えば別の行になる', async () => {
    // **これが受け入れ基準6 の本体である。** 鍵からトークンが漏れると、回した後の
    // 増分が前のトークンの行へ足し込まれ、`tokenId` は先に入った側のまま残る
    // ＝ 出力から見分けられない誤帰属になる。
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
      layer: 'manager',
      site: 'session',
      accumulation: 'oneshot',
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T11:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 2 }) }),
      tokenId: 'tok-b',
    });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.tokenId, row.totals.costUsd])).toEqual([
      ['tok-a', 1],
      ['tok-b', 2],
    ]);
  });

  it('帰属の無い行と在る行が混ざっても足し込まれない（空が「どれか1本」に化けない）', async () => {
    await store.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'oneshot',
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });
    await store.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'oneshot',
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T11:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 2 }) }),
      tokenId: 'tok-a',
    });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(2);
    // **帰属の無い行は `tokenId` を持たない**（空文字ではない）。空文字を持つと、
    // 外へ出す顔に「id が空のトークン」が1件現れる。
    const unattributed = rows.filter((row) => row.tokenId === undefined);
    expect(unattributed).toHaveLength(1);
    expect(unattributed[0]?.totals.costUsd).toBe(1);
    // 並びは「帰属の在る行 → 無い行」（pg 側と揃えてある）。
    expect(rows[1]?.tokenId).toBeUndefined();
  });

  it('帰属の無い行を2回積むと足し込まれる（鍵が毎回別にならない）', async () => {
    // **`token_id` を null 許容にすると壊れる形をここで押さえる。** pg の一意索引は
    // null どうしを重複と見なさないので、null を許すと record のたびに新しい行が
    // 挿さって積み上がらない。fs にはその機構が無いが、**器で挙動が違わないこと**
    // を両側で同じ問いとして固定する。
    for (const at of ['2026-08-25T10:00:00.000Z', '2026-08-25T11:00:00.000Z']) {
      await store.record({
        layer: 'manager',
        site: 'session',
        accumulation: 'oneshot',
        managerId: 'mgr-1',
        date: '2026-08-25',
        at,
        snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
      });
    }

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBe(2);
  });

  it('tokenId で絞り込める', async () => {
    for (const [tokenId, costUsd] of [
      ['tok-a', 1],
      ['tok-b', 2],
    ] as const) {
      await store.record({
        layer: 'manager',
        site: 'session',
        accumulation: 'oneshot',
        managerId: 'mgr-1',
        date: '2026-08-25',
        at: '2026-08-25T10:00:00.000Z',
        snapshot: snapshot({ opus: totals({ costUsd }) }),
        tokenId,
      });
    }

    const only = await store.aggregate({ tokenId: 'tok-b' });
    expect(only.rows).toHaveLength(1);
    expect(only.rows[0]?.tokenId).toBe('tok-b');
  });

  it('tokensSince は帰属が付いた record でだけ入る（プールを使わない器では最後まで null）', async () => {
    // **ここが `layersSince` と違うところである。** 層は最初の record で始まるが、
    // トークンの軸は現役の指名が無ければ取れない。揃えて入れると、トークンを1本も
    // 持っていない器が「トークン軸を観測している」と名乗る。
    await record({
      managerId: 'mgr-1',
      date: '2026-08-25',
      at: '2026-08-25T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });

    const before = await store.aggregate({});
    expect(before.since).toBe('2026-08-25T10:00:00.000Z');
    expect(before.layersSince).toBe('2026-08-25T10:00:00.000Z');
    // 台帳も層も始まっているのに、トークンの軸だけ始まっていない。
    expect(before.tokensSince).toBeNull();
    expect(before.beforeTokens).toBe(true);

    await store.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'oneshot',
      managerId: 'mgr-1',
      date: '2026-08-26',
      at: '2026-08-26T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
      tokenId: 'tok-a',
    });

    const after = await store.aggregate({});
    expect(after.tokensSince).toBe('2026-08-26T10:00:00.000Z');
    // 台帳の始点は動いていない（別の値として持っている）。
    expect(after.since).toBe('2026-08-25T10:00:00.000Z');
  });

  it('トークンの軸の始点より前を照会したら beforeTokens: true になる', async () => {
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

    expect((await store.aggregate({ from: '2026-08-25' })).beforeTokens).toBe(false);
    expect((await store.aggregate({ from: '2026-08-24' })).beforeTokens).toBe(true);
    expect((await store.aggregate({})).beforeTokens).toBe(true);
  });
});

/**
 * `recordedManagerIds`（Issue #98「台帳が取りこぼした委譲」）。
 *
 * **引数を持たない。** `aggregate()` の `from` / `to` のような絞り込みを渡す口が
 * 無いこと自体で、「照会範囲の外で記録された委譲が記録が無いに化ける」事故を
 * 構造的に防ぐ（`store.ts` の doc）。
 */
describe('FsUsageStore.recordedManagerIds', () => {
  it('1件も record していなければ空集合', async () => {
    expect(await store.recordedManagerIds()).toEqual(new Set());
  });

  /**
   * ⚠️ **期間で絞ると壊れることを測る歯。** `aggregate({ from, to })` の `rows` から
   * 「行が在る managerId の集合」を作ると、狭い範囲を照会した瞬間に、範囲の外で
   * 記録された委譲が「記録が無い」に化ける。`recordedManagerIds()` は引数を
   * 持たないので、この事故が起こる余地が無いことを直接確かめる——**古い日付の
   * 行しか無い managerId が、後で狭い範囲を `aggregate` しても消えないこと**を見る。
   */
  it('狭い範囲を aggregate しても、それより古い日付の行の managerId は消えない', async () => {
    await record({
      managerId: 'mgr-old',
      date: '2026-05-01',
      at: '2026-05-01T00:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });

    // 5月の行しか無いのに、8月だけを照会しても recordedManagerIds は変わらない
    // （aggregate の rows はここでは 0 件になる — 対照として確かめる）。
    const narrow = await store.aggregate({ from: '2026-08-01', to: '2026-08-31' });
    expect(narrow.rows).toHaveLength(0);

    expect(await store.recordedManagerIds()).toEqual(new Set(['mgr-old']));
  });

  /**
   * **基準（`usage_baseline`）ではなく行（`usage_daily`）を見ること。** 基準は
   * ゼロだけのスナップショットからでも作られうる（`foldUsageSnapshot` の doc）ので、
   * 基準だけが在って行が無い managerId を「記録が在る」と数えてはいけない。
   */
  it('基準だけが在って行が無い managerId は数えない（全部ゼロの最初のスナップショット）', async () => {
    // 基準が無い状態（初回）に全部ゼロの累積が来ると、`foldUsageSnapshot` は
    // 基準を作るが delta は空——つまり usage_baseline は作られるが usage_daily
    // には1行も残らない。
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

  /**
   * **逆方向。** 行が在って基準が無い managerId は数える——`oneshot`（蒸留）は
   * 基準を持たないが、行はそのまま usage_daily に残る。
   */
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

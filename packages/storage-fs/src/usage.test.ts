import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  USAGE_ESTIMATE_NOTICE,
  ZERO_USAGE,
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
    await store.record({ ...input, at: '2026-08-14T10:00:00.000Z' });
    // 再送（同じ result がもう一度届いた、を模す）
    await store.record({ ...input, at: '2026-08-14T10:00:05.000Z' });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals).toEqual(totals({ outputTokens: 100, costUsd: 1 }));
  });

  it('累積が増えれば差分だけ足し込む', async () => {
    await store.record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ outputTokens: 100, costUsd: 1 }) }),
    });
    await store.record({
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
    await store.record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 5 }) }),
    });
    await store.record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T11:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 3 }) }),
    });

    const { rows } = await store.aggregate({});
    expect(rows[0]?.totals.costUsd).toBe(8);
  });

  it('同じ日にモデルをまたいで積んでも別の行になる', async () => {
    await store.record({
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
    expect(await store.baseline('mgr-1')).toBeNull();

    await store.record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { sessionId: 'sess-1', models: { opus: totals({ costUsd: 1 }) } },
    });

    const baseline = await store.baseline('mgr-1');
    expect(baseline?.managerId).toBe('mgr-1');
    expect(baseline?.sessionId).toBe('sess-1');
    expect(baseline?.models.opus).toEqual(totals({ costUsd: 1 }));
  });

  it('数え直しが起きたら reset を返す（呼び出し側が日誌へ落とす材料）', async () => {
    await store.record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 5 }) }),
    });
    const fold = await store.record({
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
    await store.record({
      managerId: 'mgr-1',
      date: '2026-08-13',
      at: '2026-08-13T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 1 }) }),
    });
    await store.record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: snapshot({ opus: totals({ costUsd: 3 }) }),
    });
    await store.record({
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
    await store.record({
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
    await store.record({
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
        store.record({
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

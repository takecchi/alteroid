import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { ZERO_USAGE } from './usage-format.js';
import type { UsageLayer, UsageQuery, UsageSite } from './usage.js';

// 集計の絞り込み（6条件 × 3つの表）の振る舞いを固定する。storage-fs/src/usage-query-filter-pin.test.ts と同じ入力を使う。
interface Seed {
  date: string;
  managerId: string;
  layer: UsageLayer;
  site: UsageSite;
  tokenId?: string;
  provider: string;
}

const SEEDS: Seed[] = [
  {
    date: '2026-08-10',
    managerId: 'm1',
    layer: 'manager',
    site: 'session',
    tokenId: 't1',
    provider: 'alpha',
  },
  {
    date: '2026-08-12',
    managerId: 'm1',
    layer: 'manager',
    site: 'session',
    tokenId: 't1',
    provider: 'alpha',
  },
  {
    date: '2026-08-12',
    managerId: 'm2',
    layer: 'clone',
    site: 'session',
    tokenId: 't2',
    provider: 'beta',
  },
  { date: '2026-08-12', managerId: 'm1', layer: 'manager', site: 'distill', provider: 'alpha' },
  {
    date: '2026-08-14',
    managerId: 'm2',
    layer: 'clone',
    site: 'peer',
    tokenId: 't1',
    provider: 'beta',
  },
  { date: '2026-08-11', managerId: 'm1', layer: 'clone', site: 'session', provider: 'beta' },
  {
    date: '2026-08-14',
    managerId: 'm1',
    layer: 'manager',
    site: 'session',
    tokenId: 't2',
    provider: 'alpha',
  },
  {
    date: '2026-08-12',
    managerId: 'm2',
    layer: 'manager',
    site: 'peer',
    tokenId: 't2',
    provider: 'beta',
  },
];

const QUERIES: Record<string, UsageQuery> = {
  none: {},
  from: { from: '2026-08-11' },
  to: { to: '2026-08-12' },
  managerId: { managerId: 'm2' },
  layer: { layer: 'clone' },
  site: { site: 'peer' },
  tokenId: { tokenId: 't1' },
  all: {
    from: '2026-08-11',
    to: '2026-08-12',
    managerId: 'm1',
    layer: 'manager',
    site: 'session',
    tokenId: 't1',
  },
};

const ids = (r: {
  date: string;
  managerId: string;
  layer: string;
  site: string;
  tokenId?: string | undefined;
  provider?: string;
}) => ({
  date: r.date,
  managerId: r.managerId,
  layer: r.layer,
  site: r.site,
  tokenId: r.tokenId ?? null,
  ...(r.provider === undefined ? {} : { provider: r.provider }),
});

describe('メモリの usage.aggregate の絞り込み', () => {
  it('6条件それぞれと全部の組み合わせで、3つの表の行と並びが変わらない', async () => {
    const { usage: store } = createMemoryStores();
    for (const [i, seed] of SEEDS.entries()) {
      const at = `2026-08-20T10:00:${String(i).padStart(2, '0')}.000Z`;
      const base = {
        layer: seed.layer,
        site: seed.site,
        managerId: seed.managerId,
        date: seed.date,
        at,
        ...(seed.tokenId === undefined ? {} : { tokenId: seed.tokenId }),
      };
      await store.record({
        ...base,
        accumulation: 'oneshot',
        snapshot: { models: { opus: { ...ZERO_USAGE, outputTokens: 10 } } },
      });
      await store.recordUnmetered({ ...base, provider: seed.provider });
    }
    const out: Record<string, unknown> = {};
    for (const [name, query] of Object.entries(QUERIES)) {
      const agg = await store.aggregate(query);
      out[name] = {
        rows: agg.rows.map(ids),
        turnRows: agg.turnRows.map(ids),
        unmeteredRows: (agg.unmeteredRows ?? []).map(ids),
      };
    }
    expect(out).toMatchSnapshot();
  });
});

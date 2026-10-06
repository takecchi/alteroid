import { describe, expect, it } from 'vitest';

import { buildActivityDigest } from './digest.js';
import { createMemoryStores } from './testing.js';

describe('digest の窓は実時刻で切る（#2451）', () => {
  it('+09:00 表記の closedAt（実時刻 00:30Z）は 00:00Z〜01:00Z の窓に入る', async () => {
    const stores = createMemoryStores();
    await stores.commitments.open({
      id: 'c-off',
      at: '2026-10-05T00:00:00.000Z',
      origin: 'human',
      body: '窓の中で片付けた仕事',
    });
    await stores.commitments.close('c-off', '2026-10-06T09:30:00+09:00', '済', 'clone');
    const text = await buildActivityDigest(stores, {
      since: new Date('2026-10-06T00:00:00.000Z'),
      until: new Date('2026-10-06T01:00:00.000Z'),
    });
    expect(text).toContain('この期間に片付けた仕事: 1 件');
  });

  it('-05:00 表記の closedAt（実時刻 06:30Z）は 00:00Z〜01:00Z の窓に入らない', async () => {
    const stores = createMemoryStores();
    await stores.commitments.open({
      id: 'c-off2',
      at: '2026-10-05T00:00:00.000Z',
      origin: 'human',
      body: '窓の外で片付けた仕事',
    });
    await stores.commitments.close('c-off2', '2026-10-06T00:30:00-06:00', '済', 'clone');
    const text = await buildActivityDigest(stores, {
      since: new Date('2026-10-06T00:00:00.000Z'),
      until: new Date('2026-10-06T01:00:00.000Z'),
    });
    expect(text).toContain('この期間に片付けた仕事: 0 件');
  });
});

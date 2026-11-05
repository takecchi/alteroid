import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { verifyUsageQueryContract } from './usage-query-contract.js';

describe('UsageStore の絞り込みと並びの契約（インメモリ実装）', () => {
  it('3つの表を6条件で絞り、日付 → managerId → モデル → 層 → 場所 → 帰属（無い行は最後）の順で返す', async () => {
    await expect(verifyUsageQueryContract(createMemoryStores().usage)).resolves.toBeUndefined();
  });

  it('U+FFFF の帰属を、帰属の無い行より前に置く（番兵で代用しない）', async () => {
    const { usage } = createMemoryStores();
    const base = {
      layer: 'manager',
      site: 'session',
      managerId: 'm',
      date: '2026-08-12',
      at: '2026-08-20T10:00:00.000Z',
    } as const;
    await usage.recordUnmetered({ ...base, provider: 'p' });
    await usage.recordUnmetered({ ...base, provider: 'p', tokenId: '￿' });
    await usage.recordUnmetered({ ...base, provider: 'p', tokenId: 'a' });
    const rows = (await usage.aggregate({})).unmeteredRows ?? [];
    expect(rows.map((r) => r.tokenId)).toEqual(['a', '￿', undefined]);
  });
});

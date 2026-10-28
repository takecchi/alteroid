import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { verifyUsageResetsContract } from './usage-resets-contract.js';

describe('UsageStore の resets の契約（インメモリ実装。Issue #5409）', () => {
  it('数え直しの回数と最終時刻を基準ごとに返し、layer / managerId で絞り、日付では絞らない', async () => {
    await expect(verifyUsageResetsContract(createMemoryStores().usage)).resolves.toBeUndefined();
  });

  it('台帳が空なら resets の欄ごと無い（既存の応答を変えない）', async () => {
    const aggregate = await createMemoryStores().usage.aggregate({});
    expect(aggregate.resets).toBeUndefined();
  });
});

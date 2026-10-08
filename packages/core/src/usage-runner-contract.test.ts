import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { verifyUsageRunnerContract } from './usage-runner-contract.js';

describe('UsageStore の runner の契約（インメモリ実装）', () => {
  it('古い runner の累積は、その runner 自身の前回との差だけを積む', async () => {
    await expect(verifyUsageRunnerContract(createMemoryStores().usage)).resolves.toBeUndefined();
  });
});

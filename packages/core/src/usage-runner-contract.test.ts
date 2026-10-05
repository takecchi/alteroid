import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { verifyUsageRunnerContract } from './usage-runner-contract.js';

/** `UsageStore` の「runner ごとの最後の累積」の契約（Issue #3022 仮説1）を、インメモリ実装に対して測る。fs と pg も同じ関数を呼ぶ。 */
describe('UsageStore の runner の契約（インメモリ実装）', () => {
  it('古い runner の累積は、その runner 自身の前回との差だけを積む', async () => {
    await expect(verifyUsageRunnerContract(createMemoryStores().usage)).resolves.toBeUndefined();
  });
});

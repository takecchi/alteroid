import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { verifyUsageNulContract } from './usage-nul-contract.js';

describe('UsageStore の NUL の契約（インメモリ実装）', () => {
  it('鍵列の NUL は断らず、落として残す', async () => {
    await expect(verifyUsageNulContract(createMemoryStores().usage)).resolves.toBeUndefined();
  });
});

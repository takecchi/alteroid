import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { verifyTokenPoolContract } from './token-pool-contract.js';

describe('TokenPoolStore の入口の契約（インメモリ実装）', () => {
  it('重複 id・鍵と資格の NUL は断り、本文の NUL は落として残す', async () => {
    const stores = createMemoryStores();

    await expect(verifyTokenPoolContract(stores.tokens)).resolves.toBeUndefined();
  });
});

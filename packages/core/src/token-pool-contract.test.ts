import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { verifyTokenPoolContract } from './token-pool-contract.js';

/**
 * `TokenPoolStore` の入口の契約（issue #2927）を、**インメモリ実装**に対して測る。
 * 同じ契約を fs と pg も呼ぶ（`credential-contract.test.ts` の doc 参照）。
 */
describe('TokenPoolStore の入口の契約（インメモリ実装）', () => {
  it('重複 id・鍵と資格の NUL は断り、本文の NUL は落として残す', async () => {
    const stores = createMemoryStores();

    await expect(verifyTokenPoolContract(stores.tokens)).resolves.toBeUndefined();
  });
});

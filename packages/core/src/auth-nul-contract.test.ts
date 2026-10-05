import { describe, expect, it } from 'vitest';

import { verifyAuthNulContract } from './auth-nul-contract.js';
import { createMemoryStores } from './testing.js';

/**
 * `AuthStore` の NUL の契約（issue #3011）を、インメモリ実装に対して測る。
 * fs（`packages/storage-fs/src/auth-nul-contract.test.ts`）と pg
 * （`packages/storage-pg/src/auth-nul-contract.test.ts`）も同じ関数を呼ぶ。
 */
describe('AuthStore の NUL の契約（インメモリ実装）', () => {
  it('読むだけの口は「無い」と同じ結果、書き込みは鍵を断り本文を落として残す', async () => {
    await expect(verifyAuthNulContract(createMemoryStores().auth)).resolves.toBeUndefined();
  });
});

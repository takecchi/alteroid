import { describe, expect, it } from 'vitest';

import { verifyAuthNulContract } from './auth-nul-contract.js';
import { createMemoryStores } from './testing.js';

describe('AuthStore の NUL の契約（インメモリ実装）', () => {
  it('読むだけの口は「無い」と同じ結果、書き込みは鍵を断り本文を落として残す', async () => {
    await expect(verifyAuthNulContract(createMemoryStores().auth)).resolves.toBeUndefined();
  });
});

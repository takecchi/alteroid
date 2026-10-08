import { describe, expect, it } from 'vitest';

import { verifyJobNulContract } from './job-nul-contract.js';
import { createMemoryStores } from './testing.js';

describe('JobStore の NUL の契約（インメモリ実装）', () => {
  it('読むだけの口は「無い」と同じ結果を返し、書き込みは id を断り本文の NUL を落として残す', async () => {
    await expect(verifyJobNulContract(createMemoryStores().jobs)).resolves.toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';

import { verifySessionRegistryNulContract } from './session-registry-nul-contract.js';
import { createMemoryStores } from './testing.js';

/** `SessionRegistry` の NUL の契約（issue #2927）を、インメモリ実装に対して測る。fs と pg も同じ関数を呼ぶ。 */
describe('SessionRegistry の NUL の契約（インメモリ実装）', () => {
  it('鍵は断り、墓標は往復する', async () => {
    await expect(
      verifySessionRegistryNulContract(createMemoryStores().sessions),
    ).resolves.toBeUndefined();
  });
});

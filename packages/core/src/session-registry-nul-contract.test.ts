import { describe, expect, it } from 'vitest';

import { verifySessionRegistryGraveQueueContract } from './session-registry-grave-queue-contract.js';
import { verifySessionRegistryNulContract } from './session-registry-nul-contract.js';
import { createMemoryStores } from './testing.js';

describe('SessionRegistry の NUL の契約（インメモリ実装）', () => {
  it('鍵は断り、墓標は往復する', async () => {
    await expect(
      verifySessionRegistryNulContract(createMemoryStores().sessions),
    ).resolves.toBeUndefined();
  });

  it('墓標は上書きされず、複数持てる（#4884）', async () => {
    await expect(
      verifySessionRegistryGraveQueueContract(createMemoryStores().sessions),
    ).resolves.toBeUndefined();
  });
});

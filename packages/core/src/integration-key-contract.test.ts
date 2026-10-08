import { describe, expect, it } from 'vitest';

import { verifyIntegrationKeyStoreContract } from './integration-key-contract.js';
import { createMemoryStores } from './testing.js';

describe('IntegrationKeyStore の契約（インメモリ実装）', () => {
  it('書く・読む・並び・上書きしない・失効・NUL', async () => {
    await expect(
      verifyIntegrationKeyStoreContract(createMemoryStores().integrationKeys),
    ).resolves.toBeUndefined();
  });
});

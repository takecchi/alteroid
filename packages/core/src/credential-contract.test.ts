import { describe, expect, it } from 'vitest';

import { verifyCredentialVaultContract } from './credential-contract.js';
import { createMemoryStores } from './testing.js';

describe('CredentialVaultStore の入口の契約（インメモリ実装）', () => {
  it('NUL・不正な名前は断り、正しい入力は往復する', async () => {
    const stores = createMemoryStores();

    await expect(verifyCredentialVaultContract(stores.credentials)).resolves.toBeUndefined();
  });
});

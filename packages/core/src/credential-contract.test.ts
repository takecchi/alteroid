import { describe, expect, it } from 'vitest';

import {
  verifyCredentialSeedOnceContract,
  verifyCredentialVaultContract,
} from './credential-contract.js';
import { createMemoryStores } from './testing.js';

describe('CredentialVaultStore の入口の契約（インメモリ実装）', () => {
  it('NUL・不正な名前は断り、正しい入力は往復する', async () => {
    const stores = createMemoryStores();

    await expect(verifyCredentialVaultContract(stores.credentials)).resolves.toBeUndefined();
  });

  it('seedOnce の契約（印つきの1度だけの書き込み。2026-10-06）', async () => {
    const stores = createMemoryStores();

    await expect(verifyCredentialSeedOnceContract(stores.credentials)).resolves.toBeUndefined();
  });
});

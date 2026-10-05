import { describe, expect, it } from 'vitest';

import { verifyCredentialVaultContract } from './credential-contract.js';
import { createMemoryStores } from './testing.js';

/**
 * `CredentialVaultStore.put` の入口の契約（issue #2927）を、**インメモリ実装**に対して測る。
 * 同じ契約を fs（`storage-fs/src/index.test.ts`）と pg
 * （`storage-pg/src/index.sessions-tokens-credentials.test.ts`）も呼ぶ。
 */
describe('CredentialVaultStore の入口の契約（インメモリ実装）', () => {
  it('NUL・不正な名前は断り、正しい入力は往復する', async () => {
    const stores = createMemoryStores();

    await expect(verifyCredentialVaultContract(stores.credentials)).resolves.toBeUndefined();
  });
});

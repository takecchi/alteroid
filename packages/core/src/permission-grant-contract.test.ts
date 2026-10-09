import { describe, expect, it } from 'vitest';

import { verifyPermissionGrantStoreContract } from './permission-grant-contract.js';
import { createMemoryStores } from './testing.js';

describe('PermissionGrantStore の契約（インメモリ実装）', () => {
  it('get/list の往復・revoke/markUsedのdocに書かれた約束', async () => {
    const stores = createMemoryStores();

    await expect(
      verifyPermissionGrantStoreContract(stores.permissionGrants),
    ).resolves.toBeUndefined();
  });
});

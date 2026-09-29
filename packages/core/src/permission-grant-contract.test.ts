import { describe, expect, it } from 'vitest';

import { verifyPermissionGrantStoreContract } from './permission-grant-contract.js';
import { createMemoryStores } from './testing.js';

/**
 * `PermissionGrantStore` の契約（Issue #863。doc は `store.ts`）を、
 * **インメモリ実装**（`testing.ts`）に対して測る。
 *
 * 同じ形の歯が3つ在る。1つで測って3つとも測ったことにしない
 * （`archive-contract.test.ts` と同じ作法）:
 *
 * - インメモリ — このファイル
 * - fs — `packages/storage-fs/src/index.test.ts`
 * - pg — `packages/storage-pg/src/index.test.ts`
 */
describe('PermissionGrantStore の契約（インメモリ実装）', () => {
  it('get/list の往復・revoke/markUsedのdocに書かれた約束', async () => {
    const stores = createMemoryStores();

    await expect(
      verifyPermissionGrantStoreContract(stores.permissionGrants),
    ).resolves.toBeUndefined();
  });
});

import {
  createMemoryStores,
  type PermissionGrant,
  type PermissionGrantStore,
} from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb } from '@alteroid/storage-pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

describe('PermissionGrantStore.put() — 必須欄が欠けた grant の扱い（3実装。issue #2052）', () => {
  // 雛形の払いは歯の本体（既定 5000ms）でなく hook（30_000ms）に持たせる: WASM の起動＋migrate がワーカーで最初に呼んだ歯に乗るため。
  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  const invalidGrant = {
    id: 'grant-invalid',
    rule: 'Bash(gh release edit:*)',
    allows: ['gh release edit'],
    denies: ['gh release edit; rm -rf /'],
    approvalId: 'ap-1',
    answer: '許可します',
    route: { principalKind: 'account', accountId: 'acc-1' },
  } as unknown as PermissionGrant;

  const implementations: Array<
    [string, () => Promise<{ permissionGrants: PermissionGrantStore }>]
  > = [
    ['インメモリ実装', async () => createMemoryStores()],
    ['fs 実装', async () => createFsStores(await makeTempDir('alteroid-test-'))],
    [
      'pg 実装（PGlite）',
      async () => {
        const { db } = await createMigratedPglite();
        return createPgStoresFromDb(db);
      },
    ],
  ];

  it.each(implementations)(
    'put() は必須欄が欠けた grant を拒む（throw する）——%s',
    async (_label, createStores) => {
      const stores = await createStores();
      await expect(stores.permissionGrants.put(invalidGrant)).rejects.toThrow();
    },
  );
});

import { createMemoryStores, type JobStore, type PendingApproval } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb } from '@alteroid/storage-pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

describe('JobStore.putApproval() — 必須欄が欠けた approval の扱い（3実装。issue #2012）', () => {
  // 雛形の払いは歯の本体（既定 5000ms）でなく hook（明示 30_000ms）にさせる: WASM の起動＋migrate が歯の本体の時間に収まらないため。
  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  // 他の必須欄は有効な値のままにする: 検査したいのは `question` の欠落単独であるため。
  const invalidApproval = {
    id: 'appr-invalid',
    createdAt: '2026-09-01T00:00:00.000Z',
  } as unknown as PendingApproval;

  const implementations: Array<[string, () => Promise<{ jobs: JobStore }>]> = [
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
    'putApproval() は必須欄が欠けた approval を拒む（throw する）——%s',
    async (_label, createStores) => {
      const stores = await createStores();
      await expect(stores.jobs.putApproval(invalidApproval)).rejects.toThrow();
    },
  );
});

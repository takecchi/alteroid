import { createMemoryStores, type JobStore, type PendingApproval } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb } from '@alteroid/storage-pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

/**
 * `JobStore.putApproval()` の3実装の食い違い（issue #2012、#1715 の族）。
 *
 * fs / pg の `putApproval()` は、書く前に `pendingApprovalSchema.parse(approval)`
 * を通す——fs は
 * `grep -Fn -- 'approvals.push(pendingApprovalSchema.parse(approval))' packages/storage-fs/src/jobs.ts`、
 * pg は
 * `grep -Fn -- 'stripNulls(pendingApprovalSchema.parse(approval))' packages/storage-pg/src/jobs.ts`。
 * **インメモリ実装（`packages/core/src/testing.ts` の `createMemoryStores`）だけが
 * 検査を持たず**、`approvals.set(approval.id, isolate(approval));` を素通しで
 * 呼ぶだけだった——同じストアの `putJob`（issue #1715）と `updateApproval`
 * （issue #2007）はすでに `*Schema.parse` を通しているので、`putApproval` だけが
 * 食い違って残っていた。
 *
 * `apps/daemon` は `@alteroid/core` / `@alteroid/storage-fs` / `@alteroid/storage-pg`
 * の3つすべてに依存している（`packages/core` は fs / pg に依存できない——依存の
 * 向きが逆だと循環する）ので、ここで3実装を1本のテストとして並べて揃える
 * （#1715 は core / storage-fs / storage-pg の3ファイルに分けて揃えたが、
 * ここは1ファイル・1本の `it.each` で済む）。
 */
describe('JobStore.putApproval() — 必須欄が欠けた approval の扱い（3実装。issue #2012）', () => {
  // PGlite の雛形（WASM の起動＋migrate）は、ワーカーで最初に呼んだ歯が払う。
  // 歯の本体（既定 5000ms）でなく hook（明示 30_000ms）で払わせる（issue #2337）。
  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  // `question`（必須）が無い——実行時にしか検査できない違反（TS の型では
  // 弾けないので `as unknown as PendingApproval` で通す）。他の必須欄
  // （`id` / `createdAt`）は有効な値のまま——検査したいのは `question` の
  // 欠落単独である。
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

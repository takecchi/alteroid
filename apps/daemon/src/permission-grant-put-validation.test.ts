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

/**
 * `PermissionGrantStore.put()` の3実装の食い違い（issue #2052、#2012・#1715 の族）。
 *
 * fs / pg の `put()` は、書く前に `permissionGrantSchema.parse(grant)` を
 * 通す——fs は
 * `grep -Fn -- 'const prepared = preparePermissionGrantForPut(permissionGrantSchema.parse(grant));' packages/storage-fs/src/permission-grants.ts`、
 * pg は
 * `grep -Fn -- 'const value = preparePermissionGrantForPut(permissionGrantSchema.parse(grant));' packages/storage-pg/src/permission-grants.ts`。
 * **インメモリ実装（`packages/core/src/testing.ts` の `createMemoryStores`）
 * だけが検査を持たず**、`permissionGrantRows.set(grant.id, grant);` を素通しで
 * 呼ぶだけだった——同じストアの `revoke` / `markUsed` は既に
 * `permissionGrantSchema.parse` を通しているので、`put` だけが食い違って
 * 残っていた。
 *
 * `apps/daemon` は `@alteroid/core` / `@alteroid/storage-fs` /
 * `@alteroid/storage-pg` の3つすべてに依存している（`packages/core` は
 * fs / pg に依存できない——依存の向きが逆だと循環する）ので、ここで3実装を
 * 1本のテストとして並べて揃える（`apps/daemon/src/approval-put-validation.test.ts`
 * ＝ issue #2033 と同じ形・同じ置き場）。
 */
describe('PermissionGrantStore.put() — 必須欄が欠けた grant の扱い（3実装。issue #2052）', () => {
  // PGlite の雛形（WASM の起動＋migrate）は、ワーカーで最初に呼んだ歯が払う。
  // 歯の本体（既定 5000ms）でなく hook（明示 30_000ms）で払わせる（issue #2337）。
  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  // `grantedAt`（必須）が無い——実行時にしか検査できない違反（TS の型では
  // 弾けないので `as unknown as PermissionGrant` で通す）。他の必須欄
  // （`id` / `rule` / `allows` / `denies` / `approvalId` / `answer` /
  // `route`）は有効な値のまま——検査したいのは `grantedAt` の欠落単独で
  // ある（issue #2052 の実測: `grantedAt` を欠いた grant を正常な2行の間に
  // 置くと `list()` の sort が `Cannot read properties of undefined
  // (reading 'localeCompare')` で落ちる——順序依存のバグとして表面化する）。
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

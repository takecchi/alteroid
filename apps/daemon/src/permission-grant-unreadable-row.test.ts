import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, type PermissionGrant, type PermissionGrantStore } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * pg の `PermissionGrantStore.revoke()` / `markUsed()` が読めない行
 * （`permissionGrantSchema` に合わない。版ずれ・手編集を模す）でも
 * 書き換えたうえで「無い」を返していた食い違い（issue #2158）。fs は元から
 * 読めない行に触れずに「無い」を返す（`packages/storage-fs/src/permission-
 * grants-malformed-row-repro.test.ts` の「revoke() / markUsed() は、無い id
 * と同じく壊れた行の id にも『無い』として振る舞う」で既に固定済み）。
 *
 * `apps/daemon/src/permission-grant-put-validation.test.ts`（issue #2065。
 * `put()` の3実装横断）と同じ置き場・同じ理由——`apps/daemon` だけが
 * `@alteroid/core` / `@alteroid/storage-fs` / `@alteroid/storage-pg` の
 * 3つすべてに依存できるため、fs / pg を横並びにした歯はここへ置く。
 *
 * **インメモリ実装（`createMemoryStores`）は対象外。** `PermissionGrantStore`
 * の唯一の書き手（`put` / `revoke` / `markUsed`）が常に
 * `permissionGrantSchema.parse` を通してから `Map` へ入れる
 * （`packages/core/src/testing.ts`）——`Map` はモジュール private で外から
 * 直接書き込む口も無いので、壊れた行をそもそも作れない。fs はファイルを、
 * pg はテーブルを迂回して直接書けるが、memory には「直接書く」に相当する
 * 対象が無い。
 */
describe('PermissionGrantStore.revoke() / markUsed() — 読めない行は書き換えない（fs / pg。issue #2158）', () => {
  const GOOD_GRANT: PermissionGrant = {
    id: 'grant-good',
    rule: 'Bash(gh release edit:*)',
    allows: ['gh release edit'],
    denies: ['gh release edit; rm -rf /'],
    approvalId: 'ap-good',
    answer: '許可します',
    grantedAt: '2026-01-01T00:00:00.000Z',
    route: { principalKind: 'account', accountId: 'acc-1' },
  };

  // `route`（必須欄）が欠けている——版ずれ・手編集を模す
  // （fs 側の既存の歯 `permission-grants-malformed-row-repro.test.ts` と
  // 同じ壊し方で揃える）。
  const BROKEN_RAW = {
    id: 'grant-broken',
    rule: 'Bash(rm -rf /some/path:*)',
    allows: ['壊れた許可の本文'],
    denies: ['壊れた許可の本文2'],
    approvalId: 'ap-broken',
    answer: '許可します',
    grantedAt: '2026-01-02T00:00:00.000Z',
    // route が無い。
  };

  interface Harness {
    stores: { permissionGrants: PermissionGrantStore };
    /** 読めない行を、ストアを経由せず直接書く。 */
    insertBrokenRow(): Promise<void>;
    /** 読める行を、ストアを経由せず直接書く（対照用）。 */
    insertGoodRow(): Promise<void>;
    /** 永続化された生の行を、ストアを経由せず直接読む。 */
    readRawRow(id: string): Promise<unknown>;
  }

  async function setupFs(): Promise<Harness> {
    const root = await makeTempDir('alteroid-test-');
    const grantsPath = join(root, 'jobs', 'permission-grants.json');
    const stores = createFsStores(root);

    async function readFile_(): Promise<{ grants: unknown[] }> {
      try {
        return JSON.parse(await readFile(grantsPath, 'utf8')) as { grants: unknown[] };
      } catch {
        return { grants: [] };
      }
    }

    return {
      stores,
      async insertBrokenRow() {
        const raw = await readFile_();
        raw.grants.push(BROKEN_RAW);
        await mkdir(join(root, 'jobs'), { recursive: true });
        await writeFile(grantsPath, `${JSON.stringify(raw, null, 2)}\n`);
      },
      async insertGoodRow() {
        await stores.permissionGrants.put(GOOD_GRANT);
      },
      async readRawRow(id) {
        const raw = await readFile_();
        return raw.grants.find(
          (row) => typeof row === 'object' && row !== null && (row as { id?: unknown }).id === id,
        );
      },
    };
  }

  async function setupPg(): Promise<Harness & { close(): Promise<void> }> {
    const { client, db } = await createMigratedPglite();
    const stores = createPgStoresFromDb(db);

    return {
      stores,
      async insertBrokenRow() {
        await db.insert(tables.permissionGrants).values({
          id: BROKEN_RAW.id,
          grantedAt: new Date(BROKEN_RAW.grantedAt),
          revokedAt: null,
          record: BROKEN_RAW as unknown as Record<string, unknown>,
        });
      },
      async insertGoodRow() {
        await stores.permissionGrants.put(GOOD_GRANT);
      },
      async readRawRow(id) {
        const rows = await db
          .select({
            id: tables.permissionGrants.id,
            revokedAt: tables.permissionGrants.revokedAt,
            record: tables.permissionGrants.record,
          })
          .from(tables.permissionGrants)
          .where(eq(tables.permissionGrants.id, id));
        return rows[0];
      },
      async close() {
        await client.close();
      },
    };
  }

  const implementations: Array<[string, () => Promise<Harness & { close?(): Promise<void> }>]> = [
    ['fs 実装', setupFs],
    ['pg 実装（PGlite）', setupPg],
  ];

  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup !== undefined) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it.each(implementations)(
    'revoke() は読めない行に対して null を返し、行を1文字も書き換えない — %s',
    async (_label, setup) => {
      const harness = await setup();
      if (harness.close !== undefined) cleanup = harness.close;
      await harness.insertBrokenRow();

      const before = await harness.readRawRow(BROKEN_RAW.id);

      let result: PermissionGrant | null = null;
      await captureStderr(async () => {
        result = await harness.stores.permissionGrants.revoke(
          BROKEN_RAW.id,
          '2026-01-05T00:00:00.000Z',
        );
      });

      expect(result).toBeNull();
      const after = await harness.readRawRow(BROKEN_RAW.id);
      expect(after).toEqual(before);
    },
  );

  it.each(implementations)(
    'markUsed() は読めない行に対して false を返し、行を1文字も書き換えない — %s',
    async (_label, setup) => {
      const harness = await setup();
      if (harness.close !== undefined) cleanup = harness.close;
      await harness.insertBrokenRow();

      const before = await harness.readRawRow(BROKEN_RAW.id);

      let result: boolean | undefined;
      await captureStderr(async () => {
        result = await harness.stores.permissionGrants.markUsed(
          BROKEN_RAW.id,
          '2026-01-05T00:00:00.000Z',
        );
      });

      expect(result).toBe(false);
      const after = await harness.readRawRow(BROKEN_RAW.id);
      expect(after).toEqual(before);
    },
  );

  it.each(implementations)(
    '対照: 読める行は今までどおり revoke() / markUsed() できる — %s',
    async (_label, setup) => {
      const harness = await setup();
      if (harness.close !== undefined) cleanup = harness.close;
      await harness.insertGoodRow();

      const used = await harness.stores.permissionGrants.markUsed(
        GOOD_GRANT.id,
        '2026-01-03T00:00:00.000Z',
      );
      expect(used).toBe(true);

      const revoked = await harness.stores.permissionGrants.revoke(
        GOOD_GRANT.id,
        '2026-01-04T00:00:00.000Z',
      );
      expect(revoked).toMatchObject({
        id: GOOD_GRANT.id,
        lastUsedAt: '2026-01-03T00:00:00.000Z',
        revokedAt: '2026-01-04T00:00:00.000Z',
      });
    },
  );
});

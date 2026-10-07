import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  UnreadablePermissionGrantError,
  type PermissionGrant,
  type PermissionGrantStore,
} from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

describe('PermissionGrantStore.revoke() / markUsed() — 読めない行は書き換えない（fs / pg。issue #2158）', () => {
  // 雛形の払いは歯の本体（既定 5000ms）でなく hook（30_000ms）に持たせる: WASM の起動＋migrate がワーカーで最初に呼んだ歯に乗るため。
  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

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

  const BROKEN_RAW = {
    id: 'grant-broken',
    rule: 'Bash(rm -rf /some/path:*)',
    allows: ['壊れた許可の本文'],
    denies: ['壊れた許可の本文2'],
    approvalId: 'ap-broken',
    answer: '許可します',
    grantedAt: '2026-01-02T00:00:00.000Z',
  };

  interface Harness {
    stores: { permissionGrants: PermissionGrantStore };
    insertBrokenRow(): Promise<void>;
    insertGoodRow(): Promise<void>;
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
    'revoke() は読めない行に対して「無い」（null）と言わず UnreadablePermissionGrantError を投げ、行を1文字も書き換えない（issue #2425） — %s',
    async (_label, setup) => {
      const harness = await setup();
      if (harness.close !== undefined) cleanup = harness.close;
      await harness.insertBrokenRow();

      const before = await harness.readRawRow(BROKEN_RAW.id);

      let error: unknown;
      await captureStderr(async () => {
        try {
          await harness.stores.permissionGrants.revoke(BROKEN_RAW.id, '2026-01-05T00:00:00.000Z');
        } catch (thrown) {
          error = thrown;
        }
      });

      expect(error).toBeInstanceOf(UnreadablePermissionGrantError);
      expect(await harness.stores.permissionGrants.get(BROKEN_RAW.id)).toBeNull();
      expect(await harness.stores.permissionGrants.list()).toEqual([]);
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

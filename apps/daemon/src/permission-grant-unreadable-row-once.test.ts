import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  type PermissionGrant,
  type PermissionGrantStore,
  UnreadablePermissionGrantError,
} from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

describe('PermissionGrantStore — 壊れた行は1回だけ知らせる（fs / pg。issue #2191）', () => {
  // 雛形の払いは歯の本体（既定 5000ms）でなく hook（30_000ms）に持たせる: WASM の起動＋migrate がワーカーで最初に呼んだ歯に乗るため。
  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  const ID = 'grant-once';

  function validGrant(grantedAt: string): PermissionGrant {
    return {
      id: ID,
      rule: 'Bash(gh release edit:*)',
      allows: ['gh release edit'],
      denies: ['gh release edit; rm -rf /'],
      approvalId: 'ap-once',
      answer: '許可します',
      grantedAt,
      route: { principalKind: 'account', accountId: 'acc-1' },
    };
  }

  const BROKEN_RAW = {
    id: ID,
    rule: 'Bash(rm -rf /some/path:*)',
    allows: ['壊れた許可の本文（この文字列は跡に出てはいけない）'],
    denies: ['壊れた許可の本文2（この文字列も跡に出てはいけない）'],
    approvalId: 'ap-once',
    answer: '許可します',
    grantedAt: '2026-01-02T00:00:00.000Z',
  };

  interface Harness {
    stores: { permissionGrants: PermissionGrantStore };
    setBrokenRow(): Promise<void>;
    setGoodRow(): Promise<void>;
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

    async function setRow(raw: unknown): Promise<void> {
      const file = await readFile_();
      const withoutId = file.grants.filter(
        (row) => typeof row !== 'object' || row === null || (row as { id?: unknown }).id !== ID,
      );
      withoutId.push(raw);
      await mkdir(join(root, 'jobs'), { recursive: true });
      await writeFile(grantsPath, `${JSON.stringify({ grants: withoutId }, null, 2)}\n`);
    }

    return {
      stores,
      setBrokenRow: () => setRow(BROKEN_RAW),
      setGoodRow: () => setRow(validGrant('2026-01-01T00:00:00.000Z')),
    };
  }

  async function setupPg(): Promise<Harness & { close(): Promise<void> }> {
    const { client, db } = await createMigratedPglite();
    const stores = createPgStoresFromDb(db);

    async function upsert(record: Record<string, unknown>, grantedAt: string): Promise<void> {
      const set = { grantedAt: new Date(grantedAt), revokedAt: null, record };
      await db
        .insert(tables.permissionGrants)
        .values({ id: ID, ...set })
        .onConflictDoUpdate({ target: tables.permissionGrants.id, set });
    }

    return {
      stores,
      setBrokenRow: () => upsert(BROKEN_RAW, BROKEN_RAW.grantedAt),
      setGoodRow: () => {
        const grant = validGrant('2026-01-01T00:00:00.000Z');
        return upsert(grant as unknown as Record<string, unknown>, grant.grantedAt);
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
    'list() を3回呼んでも、知らせは1回だけ出る。本文（allows/denies）は載らない — %s',
    async (_label, setup) => {
      const harness = await setup();
      if (harness.close !== undefined) cleanup = harness.close;
      await harness.setBrokenRow();

      const lines = await captureStderr(async () => {
        await harness.stores.permissionGrants.list();
        await harness.stores.permissionGrants.list();
        await harness.stores.permissionGrants.list();
      });

      expect(lines).toHaveLength(1);
      const joined = lines.join('');
      expect(joined).toContain(ID);
      expect(joined).not.toContain(BROKEN_RAW.allows[0]);
      expect(joined).not.toContain(BROKEN_RAW.denies[0]);
    },
    // 20000 にする: `PGlite` は起動＋`migrate()` だけで数秒かかり、器が混むと pg 実装だけが時々 timeout するため。
    20000,
  );

  it.each(implementations)(
    'get() を3回呼んでも、知らせは1回だけ出る — %s',
    async (_label, setup) => {
      const harness = await setup();
      if (harness.close !== undefined) cleanup = harness.close;
      await harness.setBrokenRow();

      const lines = await captureStderr(async () => {
        await harness.stores.permissionGrants.get(ID);
        await harness.stores.permissionGrants.get(ID);
        await harness.stores.permissionGrants.get(ID);
      });

      expect(lines).toHaveLength(1);
      const joined = lines.join('');
      expect(joined).not.toContain(BROKEN_RAW.allows[0]);
      expect(joined).not.toContain(BROKEN_RAW.denies[0]);
    },
    20000,
  );

  it.each(implementations)(
    '直してから（読める形へ置き換えてから）また壊すと、もう一度知らせる — %s',
    async (_label, setup) => {
      const harness = await setup();
      if (harness.close !== undefined) cleanup = harness.close;

      await harness.setBrokenRow();
      const first = await captureStderr(async () => {
        await harness.stores.permissionGrants.list();
      });
      expect(first).toHaveLength(1);

      await harness.setGoodRow();
      const afterFix = await captureStderr(async () => {
        await harness.stores.permissionGrants.list();
      });
      expect(afterFix).toHaveLength(0);

      await harness.setBrokenRow();
      const afterReBreak = await captureStderr(async () => {
        await harness.stores.permissionGrants.list();
      });
      expect(afterReBreak).toHaveLength(1);
    },
    20000,
  );

  it.each(implementations)(
    '対照: 壊れた行が無ければ、list() を繰り返しても知らせは0件のまま — %s',
    async (_label, setup) => {
      const harness = await setup();
      if (harness.close !== undefined) cleanup = harness.close;
      await harness.setGoodRow();

      const lines = await captureStderr(async () => {
        await harness.stores.permissionGrants.list();
        await harness.stores.permissionGrants.list();
      });
      expect(lines).toHaveLength(0);
    },
    20000,
  );

  it('pg: revoke() / markUsed() は、名指しした場合は繰り返しても毎回知らせる', async () => {
    const harness = await setupPg();
    cleanup = harness.close;
    await harness.setBrokenRow();

    await captureStderr(async () => {
      await harness.stores.permissionGrants.list();
    });

    const lines = await captureStderr(async () => {
      await expect(
        harness.stores.permissionGrants.revoke(ID, '2026-01-05T00:00:00.000Z'),
      ).rejects.toBeInstanceOf(UnreadablePermissionGrantError);
      await harness.stores.permissionGrants.markUsed(ID, '2026-01-05T00:00:00.000Z');
    });

    expect(lines).toHaveLength(2);
    const joined = lines.join('');
    expect(joined).not.toContain(BROKEN_RAW.allows[0]);
    expect(joined).not.toContain(BROKEN_RAW.denies[0]);
  }, 20000);

  it('fs: id が取れない行でも、指紋を鍵に list() の知らせは1回だけになる', async () => {
    const noIdRow = {
      rule: 'Bash(rm -rf /some/path:*)',
      allows: ['本文（跡に出てはいけない）'],
      denies: [],
      approvalId: 'ap-no-id',
      answer: '許可します',
      grantedAt: '2026-01-03T00:00:00.000Z',
    };

    const root = await makeTempDir('alteroid-test-');
    const grantsPath = join(root, 'jobs', 'permission-grants.json');
    await mkdir(join(root, 'jobs'), { recursive: true });
    await writeFile(grantsPath, `${JSON.stringify({ grants: [noIdRow] }, null, 2)}\n`);
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await stores.permissionGrants.list();
      await stores.permissionGrants.list();
    });

    expect(lines).toHaveLength(1);
    expect(lines.join('')).not.toContain('本文（跡に出てはいけない）');
  });
});

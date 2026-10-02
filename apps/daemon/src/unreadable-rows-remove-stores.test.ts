import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  createMemoryStores,
  type AuthAccount,
  type PermissionGrant,
  type PermissionGrantStore,
} from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

/**
 * issue #2440。`PermissionGrantStore.removeUnreadable()` / `AuthStore.removeUnreadableAccounts()`
 * のストア単位の契約。**pg の許可の記録は同じ穴を持つ**（`record` が `permissionGrantSchema` に
 * 合わない行を作れ、`revoke` は #2425 で触らない）ので、fs / pg を横並びで測る。
 * pg のアカウントは列で持つので読めない行が無く、常に `unknown`。インメモリは両方とも持てない。
 * HTTP の口は `unreadable-rows-remove.test.ts`。
 */
const FAKE = 'FAKE_SECRET_VALUE_2440';

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
const brokenGrant = (id: string) => ({
  id,
  rule: `Bash(echo ${FAKE}:*)`,
  allows: [FAKE],
  denies: [FAKE],
  approvalId: `ap-${id}`,
  answer: FAKE,
  grantedAt: '2026-01-02T00:00:00.000Z',
  // route が無い。
});

describe('PermissionGrantStore.removeUnreadable()（fs / pg。issue #2440）', () => {
  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  interface Harness {
    store: PermissionGrantStore;
    insertBroken(id: string): Promise<void>;
    /** 永続化されている id の一覧（読める・読めないを問わない）。 */
    rawIds(): Promise<string[]>;
    close?(): Promise<void>;
  }

  async function setupFs(): Promise<Harness> {
    const root = await makeTempDir('alteroid-test-');
    const path = join(root, 'jobs', 'permission-grants.json');
    const stores = createFsStores(root);
    await stores.permissionGrants.put(GOOD_GRANT);
    const read = async () =>
      JSON.parse(await readFile(path, 'utf8')) as { grants: { id?: string }[] };
    return {
      store: stores.permissionGrants,
      async insertBroken(id) {
        const raw = await read();
        raw.grants.push(brokenGrant(id));
        await mkdir(join(root, 'jobs'), { recursive: true });
        await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
      },
      async rawIds() {
        return (await read()).grants.map((row) => row.id ?? '(no id)');
      },
    };
  }

  async function setupPg(): Promise<Harness> {
    const { client, db } = await createMigratedPglite();
    const stores = createPgStoresFromDb(db);
    await stores.permissionGrants.put(GOOD_GRANT);
    return {
      store: stores.permissionGrants,
      async insertBroken(id) {
        await db.insert(tables.permissionGrants).values({
          id,
          grantedAt: new Date('2026-01-02T00:00:00.000Z'),
          revokedAt: null,
          record: brokenGrant(id) as unknown as Record<string, unknown>,
        });
      },
      async rawIds() {
        const rows = await db
          .select({ id: tables.permissionGrants.id })
          .from(tables.permissionGrants);
        return rows.map((row) => row.id).sort();
      },
      async close() {
        await client.close();
      },
    };
  }

  const implementations: Array<[string, () => Promise<Harness>]> = [
    ['fs 実装', setupFs],
    ['pg 実装（PGlite）', setupPg],
  ];

  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  async function open(setup: () => Promise<Harness>): Promise<Harness> {
    const harness = await setup();
    cleanup = harness.close;
    await captureStderr(async () => {
      await harness.insertBroken('grant-bad');
      await harness.insertBroken('grant-bad-2');
    });
    return harness;
  }

  it.each(implementations)(
    '指した読めない行だけを消し、消す前に beforeRemove を呼ぶ。読める行・指していない読めない行は残る — %s',
    async (_label, setup) => {
      const h = await open(setup);
      const order: string[] = [];

      let result: Awaited<ReturnType<PermissionGrantStore['removeUnreadable']>> | undefined;
      await captureStderr(async () => {
        result = await h.store.removeUnreadable(['grant-bad', 'grant-bad'], {
          beforeRemove: async (ids) => {
            order.push(`before:${ids.join(',')}:${(await h.rawIds()).includes('grant-bad')}`);
          },
        });
      });

      expect(result).toEqual({ kind: 'removed', ids: ['grant-bad'] });
      // 呼ばれた時点では、まだ消えていない。
      expect(order).toEqual(['before:grant-bad:true']);
      const ids = await h.rawIds();
      expect(ids).not.toContain('grant-bad');
      expect(ids).toContain('grant-bad-2');
      expect(ids).toContain('grant-good');
      expect((await h.store.get('grant-good'))?.id).toBe('grant-good');
    },
  );

  it.each(implementations)(
    '知らない id・読める行の id が1つでもあれば、何も消さず beforeRemove も呼ばない（全部か無か） — %s',
    async (_label, setup) => {
      const h = await open(setup);
      const before = await h.rawIds();
      let called = false;

      for (const wrong of ['no-such', 'grant-good']) {
        let result: unknown;
        await captureStderr(async () => {
          result = await h.store.removeUnreadable(['grant-bad', wrong], {
            beforeRemove: async () => {
              called = true;
            },
          });
        });
        expect(result).toEqual({ kind: 'unknown', count: 1 });
      }

      expect(called).toBe(false);
      expect(await h.rawIds()).toEqual(before);
    },
  );

  it.each(implementations)(
    'beforeRemove が投げたら何も消さず、そのまま投げ直す — %s',
    async (_label, setup) => {
      const h = await open(setup);
      const before = await h.rawIds();

      await captureStderr(async () => {
        await expect(
          h.store.removeUnreadable(['grant-bad'], {
            beforeRemove: async () => {
              throw new Error('journal down');
            },
          }),
        ).rejects.toThrow('journal down');
      });

      expect(await h.rawIds()).toEqual(before);
    },
  );
});

describe('AuthStore.removeUnreadableAccounts()（fs。pg・インメモリは読めない行を持てない。issue #2440）', () => {
  const GOOD: AuthAccount = {
    id: 'acct-good',
    displayName: 'Good',
    email: 'good@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    grantedAt: '2026-01-01T00:00:00.000Z',
    grantedBy: 'operator',
    ownerDeclaredAt: null,
  };
  // displayName が無い。
  const brokenAccount = (id: string) => ({
    id,
    email: `${FAKE}@example.test`,
    createdAt: '2026-01-02T00:00:00.000Z',
    lastLoginAt: null,
    grantedAt: '2026-01-02T00:00:00.000Z',
    grantedBy: 'operator',
    ownerDeclaredAt: null,
  });

  async function setup() {
    const root = await makeTempDir('alteroid-test-');
    const path = join(root, 'auth', 'auth.json');
    const stores = createFsStores(root);
    await stores.auth.putAccount(GOOD);
    const raw = JSON.parse(await readFile(path, 'utf8')) as { accounts: unknown[] };
    raw.accounts.push(brokenAccount('acct-bad'), brokenAccount('acct-bad-2'));
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
    const ids = async () =>
      (JSON.parse(await readFile(path, 'utf8')) as { accounts: { id: string }[] }).accounts.map(
        (row) => row.id,
      );
    return { stores, ids, path };
  }

  it('指した読めない行だけを消す。beforeRemove は消す前に呼ばれる。読めた行・identity には触れない', async () => {
    const { stores, ids } = await setup();
    const seen: boolean[] = [];
    let result: unknown;
    await captureStderr(async () => {
      result = await stores.auth.removeUnreadableAccounts(['acct-bad'], {
        beforeRemove: async () => {
          seen.push((await ids()).includes('acct-bad'));
        },
      });
    });
    expect(result).toEqual({ kind: 'removed', ids: ['acct-bad'] });
    expect(seen).toEqual([true]);
    expect(await ids()).toEqual(['acct-good', 'acct-bad-2']);
    expect((await stores.auth.getAccount('acct-good'))?.id).toBe('acct-good');
  });

  it('知らない id・読める行の id があれば何も消さない。beforeRemove が投げても何も消さない', async () => {
    const { stores, ids, path } = await setup();
    const before = await readFile(path, 'utf8');
    let results: unknown[] = [];
    await captureStderr(async () => {
      results = [
        await stores.auth.removeUnreadableAccounts(['acct-bad', 'no-such']),
        await stores.auth.removeUnreadableAccounts(['acct-good']),
      ];
      await expect(
        stores.auth.removeUnreadableAccounts(['acct-bad'], {
          beforeRemove: async () => {
            throw new Error('journal down');
          },
        }),
      ).rejects.toThrow('journal down');
    });
    expect(results).toEqual([
      { kind: 'unknown', count: 1 },
      { kind: 'unknown', count: 1 },
    ]);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await ids()).toContain('acct-bad');
  });

  it('pg とインメモリは読めない行を持てないので、常に unknown（何も消さない）', async () => {
    const { client, db } = await createMigratedPglite();
    try {
      const pg = createPgStoresFromDb(db);
      const memory = createMemoryStores();
      for (const store of [pg.auth, memory.auth]) {
        expect(await store.removeUnreadableAccounts(['a', 'b', 'a'])).toEqual({
          kind: 'unknown',
          count: 2,
        });
      }
      expect(await memory.permissionGrants.removeUnreadable(['a'])).toEqual({
        kind: 'unknown',
        count: 1,
      });
    } finally {
      await client.close();
    }
  }, 30_000);
});

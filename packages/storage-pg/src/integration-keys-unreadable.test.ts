import type { IntegrationKeyRecord } from '@alteroid/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';
import { integrationKeys } from './schema.js';

const FAKE = 'FAKE_SECRET_VALUE_3216';

const GOOD: IntegrationKeyRecord = {
  id: 'key-good',
  name: 'ci',
  source: 'ci.main',
  sha256: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'operator',
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  maxBodyBytes: null,
  ratePerMinute: null,
};

let client: Awaited<ReturnType<typeof createMigratedPglite>>['client'];
let db: Awaited<ReturnType<typeof createMigratedPglite>>['db'];
let stores: PgStores;

beforeAll(async () => {
  await migratedTemplate();
}, 60_000);

beforeEach(async () => {
  const made = await createMigratedPglite();
  client = made.client;
  db = made.db;
  stores = createPgStoresFromDb(made.db);
  await stores.integrationKeys.putIntegrationKey(GOOD);
  for (const [id, sha] of [
    ['key-bad', 'b'],
    ['key-bad-2', 'c'],
  ] as const) {
    await db.insert(integrationKeys).values({
      id,
      name: FAKE,
      source: 'BAD SOURCE',
      sha256: sha.repeat(64),
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      createdBy: 'operator',
    });
  }
}, 30_000);

afterEach(async () => {
  await client.close();
});

const rawIds = async () =>
  (await db.select({ id: integrationKeys.id }).from(integrationKeys)).map((row) => row.id).sort();

describe('PgIntegrationKeyStore の読めない行（issue #3216）', () => {
  it('一覧・引く口には出さず、listUnreadable が id と不正な欄名だけを返す', async () => {
    expect((await stores.integrationKeys.listIntegrationKeys()).map((key) => key.id)).toEqual([
      'key-good',
    ]);
    expect(await stores.integrationKeys.getIntegrationKey('key-bad')).toBeNull();
    expect(await stores.integrationKeys.findIntegrationKeyBySha256('b'.repeat(64))).toBeNull();
    const unreadable = await stores.integrationKeys.listUnreadableIntegrationKeys();
    expect(unreadable).toEqual([
      { id: 'key-bad', reason: '不正な欄: source' },
      { id: 'key-bad-2', reason: '不正な欄: source' },
    ]);
    expect(JSON.stringify(unreadable)).not.toContain(FAKE);
  });

  it('読めない行の失効は触らずに not_found', async () => {
    expect(
      await stores.integrationKeys.revokeIntegrationKey('key-bad', '2026-02-01T00:00:00.000Z'),
    ).toEqual({ status: 'not_found' });
    const rows = await db.select().from(integrationKeys);
    expect(rows.find((row) => row.id === 'key-bad')?.revokedAt).toBeNull();
  });

  it('指した読めない行だけを消し、消す前に beforeRemove を呼ぶ。読める行・指していない行は残る', async () => {
    const order: string[] = [];
    const result = await stores.integrationKeys.removeUnreadableIntegrationKeys(
      ['key-bad', 'key-bad'],
      {
        beforeRemove: async (ids) => {
          order.push(`before:${ids.join(',')}:${(await rawIds()).includes('key-bad')}`);
        },
      },
    );
    expect(result).toEqual({ kind: 'removed', ids: ['key-bad'] });
    expect(order).toEqual(['before:key-bad:true']);
    expect(await rawIds()).toEqual(['key-bad-2', 'key-good']);
    expect((await stores.integrationKeys.getIntegrationKey('key-good'))?.id).toBe('key-good');
  });

  it('知らない id・読める行の id・NUL を含む id が1つでもあれば、何も消さず beforeRemove も呼ばない', async () => {
    let called = false;
    for (const wrong of ['no-such', 'key-good', 'key\u0000bad']) {
      const result = await stores.integrationKeys.removeUnreadableIntegrationKeys(
        ['key-bad', wrong],
        {
          beforeRemove: async () => {
            called = true;
          },
        },
      );
      expect(result).toEqual({ kind: 'unknown', count: 1 });
    }
    expect(called).toBe(false);
    expect(await rawIds()).toEqual(['key-bad', 'key-bad-2', 'key-good']);
  });

  it('beforeRemove が投げたら何も消さず、そのまま投げ直す', async () => {
    await expect(
      stores.integrationKeys.removeUnreadableIntegrationKeys(['key-bad'], {
        beforeRemove: async () => {
          throw new Error('journal down');
        },
      }),
    ).rejects.toThrow('journal down');
    expect(await rawIds()).toEqual(['key-bad', 'key-bad-2', 'key-good']);
  });
});

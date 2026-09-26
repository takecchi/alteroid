import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * 許可の記録（`PermissionGrantStore`）の lost update。fs 版
 * （`packages/storage-fs/src/permission-grant-concurrent-writes.test.ts`）と
 * 同じ歯を pg 実装（`PgPermissionGrantStore`）に当てる——`PermissionGrantStore`
 * は「能力の差を作らない」別の器なので、両方が同じ形で直っていることを
 * 確かめる。
 */
describe('PermissionGrantStore.revoke() / markUsed() — lost update を作らない（pg 実装）', () => {
  let client: PGlite;
  let db: Db;
  let stores: PgStores;

  const GRANT = {
    id: 'grant-1',
    rule: 'Bash(gh release edit:*)',
    allows: ['gh release edit'],
    denies: ['gh release edit; rm -rf /'],
    approvalId: 'ap-1',
    answer: '許可します',
    grantedAt: '2026-01-01T00:00:00.000Z',
    route: { principalKind: 'account' as const, accountId: 'acc-1' },
  };

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client);
    await migrate(db);
    stores = createPgStoresFromDb(db);
  });

  afterEach(async () => {
    await client.close();
  });

  it('markUsed の後に revoke が来ても、lastUsedAt は残る', async () => {
    await stores.permissionGrants.put(GRANT);
    await stores.permissionGrants.markUsed('grant-1', '2026-01-02T00:00:00.000Z');

    const revoked = await stores.permissionGrants.revoke('grant-1', '2026-01-03T00:00:00.000Z');

    expect(revoked).toMatchObject({
      id: 'grant-1',
      lastUsedAt: '2026-01-02T00:00:00.000Z',
      revokedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(await stores.permissionGrants.get('grant-1')).toEqual(revoked);
  });

  it('revoke の後に markUsed が来ても、revokedAt は残る（消えたら復活したことになる）', async () => {
    await stores.permissionGrants.put(GRANT);
    const revoked = await stores.permissionGrants.revoke('grant-1', '2026-01-02T00:00:00.000Z');
    expect(revoked?.revokedAt).toBe('2026-01-02T00:00:00.000Z');

    await stores.permissionGrants.markUsed('grant-1', '2026-01-03T00:00:00.000Z');

    const after = await stores.permissionGrants.get('grant-1');
    expect(after?.revokedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(after?.lastUsedAt).toBe('2026-01-03T00:00:00.000Z');
  });

  it('revoke と markUsed が本当に同時に来ても、両方の効果が残る（実際の DB へ競わせる）', async () => {
    await stores.permissionGrants.put(GRANT);

    const [revoked] = await Promise.all([
      stores.permissionGrants.revoke('grant-1', '2026-01-02T00:00:00.000Z'),
      stores.permissionGrants.markUsed('grant-1', '2026-01-02T00:00:00.500Z'),
    ]);
    expect(revoked?.revokedAt).toBe('2026-01-02T00:00:00.000Z');

    const after = await stores.permissionGrants.get('grant-1');
    expect(after?.revokedAt).toBeDefined();
    expect(after?.lastUsedAt).toBe('2026-01-02T00:00:00.500Z');
  });

  it('既に取り消し済みなら、後から来た revoke は元の revokedAt を保つ（上書きしない）', async () => {
    await stores.permissionGrants.put(GRANT);
    await stores.permissionGrants.revoke('grant-1', '2026-01-02T00:00:00.000Z');

    const second = await stores.permissionGrants.revoke('grant-1', '2026-01-05T00:00:00.000Z');

    expect(second?.revokedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('markUsed は既存より古い時刻では戻さない', async () => {
    await stores.permissionGrants.put(GRANT);
    await stores.permissionGrants.markUsed('grant-1', '2026-01-05T00:00:00.000Z');

    await stores.permissionGrants.markUsed('grant-1', '2026-01-02T00:00:00.000Z');

    const after = await stores.permissionGrants.get('grant-1');
    expect(after?.lastUsedAt).toBe('2026-01-05T00:00:00.000Z');
  });

  it('無い id への revoke は null、markUsed は何もしない', async () => {
    expect(
      await stores.permissionGrants.revoke('no-such-id', '2026-01-01T00:00:00.000Z'),
    ).toBeNull();
    await expect(
      stores.permissionGrants.markUsed('no-such-id', '2026-01-01T00:00:00.000Z'),
    ).resolves.toBeUndefined();
    expect(await stores.permissionGrants.list()).toEqual([]);
  });
});

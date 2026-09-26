import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * 許可の記録（`PermissionGrantStore`）の lost update。
 *
 * `apps/daemon/src/app.ts`（人間の取り消し）と `packages/core/src/clone.ts` の
 * `#onPreToolUse`（クローンの使用記録）は、どちらもかつて「`get()` /
 * `list()` で読んだ古い写しに1欄だけ足して `put()` する」形をしていた。
 * `put()` は無条件の全置換で版チェックを持たないので、この「読んでから書く」
 * が重なると、後から書き戻ったほうが先の変更を丸ごと消していた——**人間が
 * 取り消した許可が、クローンの使用記録の書き込みで生き返る**（直す前の赤い
 * 再現は `packages/core/src/clone.test.ts` の「人間の取り消しが、
 * #onPreToolUse の list() と put() の間に割り込んでも消えない」）。
 *
 * `revoke()` / `markUsed()` はこの「読んでから書く」をストア側の排他区間
 * （`FsPermissionGrantStore.#update`）へ引き取る——ここはその直った側の歯
 * （`ScheduleStore.editRequest` / issue #1654 と同じ形）。
 */
describe('PermissionGrantStore.revoke() / markUsed() — lost update を作らない（fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

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
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
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

  it('revoke と markUsed が本当に同時に来ても、両方の効果が残る（実際の排他区間で競わせる）', async () => {
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

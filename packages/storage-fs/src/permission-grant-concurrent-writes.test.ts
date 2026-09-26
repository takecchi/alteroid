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

    // 取り消し済みの許可には「使った」を記録しない（Issue #1687）。
    expect(await stores.permissionGrants.markUsed('grant-1', '2026-01-03T00:00:00.000Z')).toBe(
      false,
    );

    const after = await stores.permissionGrants.get('grant-1');
    expect(after?.revokedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(after?.lastUsedAt).toBeUndefined();
  });

  it('revoke と markUsed が本当に同時に来ても、両方の効果が残る（実際の排他区間で競わせる）', async () => {
    await stores.permissionGrants.put(GRANT);

    const [revoked, used] = await Promise.all([
      stores.permissionGrants.revoke('grant-1', '2026-01-02T00:00:00.000Z'),
      stores.permissionGrants.markUsed('grant-1', '2026-01-02T00:00:00.500Z'),
    ]);
    expect(revoked?.revokedAt).toBe('2026-01-02T00:00:00.000Z');

    const after = await stores.permissionGrants.get('grant-1');
    expect(after?.revokedAt).toBeDefined();
    // どちらが先に区間へ入るかは決まらない。markUsed が先なら記録して true、
    // revoke が先なら記録せず false（Issue #1687）——戻り値と記録が必ず一致する。
    expect(after?.lastUsedAt).toBe(used ? '2026-01-02T00:00:00.500Z' : undefined);
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

  it('無い id への revoke は null、markUsed は何もせず false', async () => {
    expect(
      await stores.permissionGrants.revoke('no-such-id', '2026-01-01T00:00:00.000Z'),
    ).toBeNull();
    await expect(
      stores.permissionGrants.markUsed('no-such-id', '2026-01-01T00:00:00.000Z'),
    ).resolves.toBe(false);
    expect(await stores.permissionGrants.list()).toEqual([]);
  });

  /**
   * **Issue #1687。** `markUsed` は「在って、取り消されていなかったか」を返し、
   * 取り消し済みなら記録しない——`#onPreToolUse` はこの戻り値で通すかを決める。
   */
  it('markUsed は、生きている許可なら true、取り消し済みなら記録せず false を返す', async () => {
    await stores.permissionGrants.put(GRANT);
    expect(await stores.permissionGrants.markUsed('grant-1', '2026-01-02T00:00:00.000Z')).toBe(
      true,
    );
    // 既存より古い時刻で進めなかった回も、生きている許可なので true。
    expect(await stores.permissionGrants.markUsed('grant-1', '2026-01-01T00:00:00.000Z')).toBe(
      true,
    );

    await stores.permissionGrants.revoke('grant-1', '2026-01-03T00:00:00.000Z');
    expect(await stores.permissionGrants.markUsed('grant-1', '2026-01-04T00:00:00.000Z')).toBe(
      false,
    );
    const stored = await stores.permissionGrants.get('grant-1');
    expect(stored?.lastUsedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(stored?.revokedAt).toBe('2026-01-03T00:00:00.000Z');
  });
});

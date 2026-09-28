import type { AuthAccount } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * `AuthStore.revokeAccountAccess`（issue #1915）単体の歯（fs 実装）。
 *
 * `FsAuthStore.revokeAccountAccess` は排他区間の中でいまのファイルの行を
 * 読んで書く（`markAccountLoggedIn` と同じ形）。ここでは単体で、
 * `grantedAt` / `grantedBy` / `ownerDeclaredAt` の3欄だけが動いて
 * 他の欄に触れないことを見る。
 */
describe('AuthStore.revokeAccountAccess（fs 実装、issue #1915）', () => {
  it('grantedAt / grantedBy / ownerDeclaredAt だけを null にし、他の欄には触れない。無い id では何もしない', async () => {
    const store = createFsStores(await makeTempDir('alteroid-test-')).auth;
    const account: AuthAccount = {
      id: 'account-revoke',
      displayName: 'Alice',
      email: 'alice@example.test',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastLoginAt: '2026-09-04T00:00:00.000Z',
      grantedAt: '2026-09-02T00:00:00.000Z',
      grantedBy: 'operator',
      ownerDeclaredAt: '2026-09-03T00:00:00.000Z',
    };
    await store.putAccount(account);

    await store.revokeAccountAccess(account.id);
    const updated = await store.getAccount(account.id);
    expect(updated?.grantedAt).toBeNull();
    expect(updated?.grantedBy).toBeNull();
    expect(updated?.ownerDeclaredAt).toBeNull();
    expect(updated?.lastLoginAt).toBe('2026-09-04T00:00:00.000Z');
    expect(updated?.email).toBe('alice@example.test');
    expect(updated?.displayName).toBe('Alice');

    // 無い id では何も起きない（投げない）。
    await expect(store.revokeAccountAccess('no-such-account')).resolves.toBeUndefined();
  });
});

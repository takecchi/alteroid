import { describe, expect, it } from 'vitest';

import type { AuthAccount } from './auth.js';
import { createMemoryStores } from './testing.js';

/**
 * `AuthStore.markAccountLoggedIn`（issue #1870）単体の歯（メモリ実装）。
 *
 * `completeLogin` の再ログイン分岐が使う1操作そのものを直接叩き、
 * `lastLoginAt` だけが動いて `grantedAt` / `grantedBy` / `ownerDeclaredAt`
 * には触れないことを見る——`markAccessTokenUsed`（issue #1782）の対の歯と
 * 同じ形。
 */
describe('AuthStore.markAccountLoggedIn（メモリ実装、issue #1870）', () => {
  it('lastLoginAt だけを書き、grantedAt / grantedBy / ownerDeclaredAt には触れない。無い id では何もしない', async () => {
    const store = createMemoryStores().auth;
    const account: AuthAccount = {
      id: 'account-mark',
      displayName: 'Alice',
      email: 'alice@example.test',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastLoginAt: '2026-09-01T00:00:00.000Z',
      grantedAt: '2026-09-02T00:00:00.000Z',
      grantedBy: 'operator',
      ownerDeclaredAt: '2026-09-03T00:00:00.000Z',
    };
    await store.putAccount(account);

    await store.markAccountLoggedIn(account.id, '2026-09-04T00:00:00.000Z');
    const updated = await store.getAccount(account.id);
    expect(updated?.lastLoginAt).toBe('2026-09-04T00:00:00.000Z');
    // 触っていない欄はそのまま残る。
    expect(updated?.grantedAt).toBe('2026-09-02T00:00:00.000Z');
    expect(updated?.grantedBy).toBe('operator');
    expect(updated?.ownerDeclaredAt).toBe('2026-09-03T00:00:00.000Z');
    expect(updated?.email).toBe('alice@example.test');
    expect(updated?.displayName).toBe('Alice');

    // 無い id では何も起きない（投げない）。
    await expect(
      store.markAccountLoggedIn('no-such-account', '2026-09-05T00:00:00.000Z'),
    ).resolves.toBeUndefined();
  });
});

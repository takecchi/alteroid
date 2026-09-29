import { describe, expect, it } from 'vitest';

import type { AccessTokenRecord, AuthAccount } from './auth.js';
import { createMemoryStores } from './testing.js';

/**
 * `AuthStore.revokeAccessToken`（issue #1757、ログアウトの実体）——インメモリ実装。
 *
 * fs / pg の対の歯は `packages/storage-fs/src/index.test.ts` /
 * `packages/storage-pg/src/index.auth.test.ts` の同名 `describe` ブロックにある。
 * 3実装とも同じ形（1本だけを失効させる、冪等、無い id は not_found）を守る。
 */
describe('revokeAccessToken（メモリ実装）', () => {
  const account: AuthAccount = {
    id: 'account-1',
    displayName: 'Owner',
    email: 'owner@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-01-01T00:00:00.000Z',
    grantedAt: null,
    grantedBy: null,
    ownerDeclaredAt: null,
  };

  const token: AccessTokenRecord = {
    id: 'token-1',
    accountId: 'account-1',
    sha256: 'a'.repeat(64),
    label: 'laptop',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };

  it('失効させる（revokedAt が立ち、同じアカウントの別のトークンは影響を受けない）', async () => {
    const stores = createMemoryStores();
    await stores.auth.putAccount(account);
    await stores.auth.putAccessToken(token);
    const other: AccessTokenRecord = { ...token, id: 'token-2', sha256: 'b'.repeat(64) };
    await stores.auth.putAccessToken(other);

    const result = await stores.auth.revokeAccessToken('token-1', '2026-01-02T00:00:00.000Z');
    expect(result).toEqual({
      status: 'revoked',
      token: { ...token, revokedAt: '2026-01-02T00:00:00.000Z' },
    });
    expect((await stores.auth.findAccessTokenBySha256('a'.repeat(64)))?.revokedAt).toBe(
      '2026-01-02T00:00:00.000Z',
    );
    // 同じアカウントの別のトークンは巻き込まれない（アカウント単位ではなくトークン単位）。
    expect((await stores.auth.findAccessTokenBySha256('b'.repeat(64)))?.revokedAt).toBeNull();
  });

  it('もう一度呼んでも、先に立った時刻を動かさない（冪等）', async () => {
    const stores = createMemoryStores();
    await stores.auth.putAccount(account);
    await stores.auth.putAccessToken(token);

    await stores.auth.revokeAccessToken('token-1', '2026-01-02T00:00:00.000Z');
    const second = await stores.auth.revokeAccessToken('token-1', '2026-01-03T00:00:00.000Z');

    expect(second).toEqual({
      status: 'already_revoked',
      token: { ...token, revokedAt: '2026-01-02T00:00:00.000Z' },
    });
    expect((await stores.auth.findAccessTokenBySha256('a'.repeat(64)))?.revokedAt).toBe(
      '2026-01-02T00:00:00.000Z',
    );
  });

  it('無い id は not_found', async () => {
    const stores = createMemoryStores();
    expect(await stores.auth.revokeAccessToken('居ない', '2026-01-02T00:00:00.000Z')).toEqual({
      status: 'not_found',
    });
  });
});

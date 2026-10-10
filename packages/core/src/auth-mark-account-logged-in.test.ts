import { describe, expect, it } from 'vitest';

import type { AuthAccount } from './auth.js';
import { createMemoryStores } from './testing.js';

describe('AuthStore.markAccountLoggedIn（メモリ実装、issue #1870）', () => {
  it('lastLoginAt だけを書き、grantedAt / grantedBy には触れない。無い id では何もしない', async () => {
    const store = createMemoryStores().auth;
    const account: AuthAccount = {
      id: 'account-mark',
      displayName: 'Alice',
      email: 'alice@example.test',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastLoginAt: '2026-09-01T00:00:00.000Z',
      grantedAt: '2026-09-02T00:00:00.000Z',
      grantedBy: 'operator',
    };
    await store.putAccount(account);

    await store.markAccountLoggedIn(account.id, '2026-09-04T00:00:00.000Z');
    const updated = await store.getAccount(account.id);
    expect(updated?.lastLoginAt).toBe('2026-09-04T00:00:00.000Z');
    expect(updated?.grantedAt).toBe('2026-09-02T00:00:00.000Z');
    expect(updated?.grantedBy).toBe('operator');
    expect(updated?.email).toBe('alice@example.test');
    expect(updated?.displayName).toBe('Alice');

    await expect(
      store.markAccountLoggedIn('no-such-account', '2026-09-05T00:00:00.000Z'),
    ).resolves.toBeUndefined();
  });
});

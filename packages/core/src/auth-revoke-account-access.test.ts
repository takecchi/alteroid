import { describe, expect, it } from 'vitest';

import type { AuthAccount, AuthStore } from './auth.js';
import { createMemoryStores } from './testing.js';

describe('AuthStore.revokeAccountAccess（メモリ実装、issue #1915）', () => {
  it('grantedAt / grantedBy だけを null にし、他の欄には触れない。無い id では何もしない', async () => {
    const store: AuthStore = createMemoryStores().auth;
    const account: AuthAccount = {
      id: 'account-revoke',
      displayName: 'Alice',
      email: 'alice@example.test',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastLoginAt: '2026-09-04T00:00:00.000Z',
      grantedAt: '2026-09-02T00:00:00.000Z',
      grantedBy: 'operator',
    };
    await store.putAccount(account);

    await store.revokeAccountAccess(account.id);
    const updated = await store.getAccount(account.id);
    expect(updated?.grantedAt).toBeNull();
    expect(updated?.grantedBy).toBeNull();
    expect(updated?.lastLoginAt).toBe('2026-09-04T00:00:00.000Z');
    expect(updated?.email).toBe('alice@example.test');
    expect(updated?.displayName).toBe('Alice');

    await expect(store.revokeAccountAccess('no-such-account')).resolves.toBeUndefined();
  });
});

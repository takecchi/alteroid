import { describe, expect, it } from 'vitest';

import { decodeState, type AuthStore } from './auth.js';
import {
  createAuthProviderRegistry,
  type OAuthProfile,
  type OAuthProvider,
} from './auth-providers.js';
import { createAuthService } from './auth-service.js';
import { createMemoryStores } from './testing.js';

const ALICE: OAuthProfile = {
  subject: 'sub-alice',
  email: 'alice@example.test',
  emailVerified: true,
  displayName: 'Alice',
};

function fakeProvider(): OAuthProvider {
  return {
    kind: 'oauth2',
    id: 'fake',
    label: 'Fake',
    authorizationUrl: (request) => `https://example.test/authorize?state=${request.state}`,
    exchange: async () => ALICE,
  };
}

function delayedAccountWrites(inner: AuthStore, onRead: () => void, writeGate: Promise<void>) {
  return {
    ...inner,
    getAccount: async (id: string) => {
      const result = await inner.getAccount(id);
      onRead();
      return result;
    },
    putAccount: async (account: Parameters<AuthStore['putAccount']>[0]) => {
      await writeGate;
      return inner.putAccount(account);
    },
    revokeAccountAccess: async (accountId: string) => {
      await writeGate;
      return (
        inner as unknown as { revokeAccountAccess(id: string): Promise<void> }
      ).revokeAccountAccess(accountId);
    },
  } as AuthStore;
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('AuthService.revoke は直前に完了した再ログインの lastLoginAt を巻き戻さない（issue #1915）', () => {
  it('revoke が読んだ直後に再ログインが完了しても、lastLoginAt は巻き戻ってはいけない', async () => {
    const store = createMemoryStores().auth;
    let counter = 0;
    let ticks = 0;
    const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ticks++));
    const providers = createAuthProviderRegistry([fakeProvider()]);
    const service = createAuthService({ store, providers, now, newId: () => `id-${++counter}` });

    const first = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const stateFirst = decodeState(new URL(first.authorizationUrl).searchParams.get('state') ?? '');
    const completedFirst = await service.completeLogin({
      state: `${stateFirst?.requestId}.${stateFirst?.nonce}`,
      code: 'unused',
    });
    expect(completedFirst.status).toBe('ok');
    if (completedFirst.status !== 'ok') throw new Error('ログインできていない');
    const accountId = completedFirst.accountId;

    expect((await service.grant(accountId, 'operator')).status).toBe('granted');
    const beforeRace = await store.getAccount(accountId);
    const lastLoginBeforeRelogin = beforeRace?.lastLoginAt ?? null;
    expect(lastLoginBeforeRelogin).not.toBeNull();

    const second = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const stateSecond = decodeState(
      new URL(second.authorizationUrl).searchParams.get('state') ?? '',
    );

    const write = gate();
    const read = gate();
    const racingStore = delayedAccountWrites(store, () => read.release(), write.promise);
    const racingService = createAuthService({
      store: racingStore,
      providers,
      now,
      newId: () => `id-${++counter}`,
    });

    const revokePromise = racingService.revoke(accountId);

    await read.promise;

    const reloginResult = await service.completeLogin({
      state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
      code: 'unused',
    });
    expect(reloginResult.status).toBe('ok');
    const afterRelogin = await store.getAccount(accountId);
    const lastLoginAfterRelogin = afterRelogin?.lastLoginAt ?? null;
    expect(lastLoginAfterRelogin).not.toBe(lastLoginBeforeRelogin);
    expect(afterRelogin?.grantedAt).not.toBeNull();

    write.release();
    const revoked = await revokePromise;
    expect(revoked?.grantedAt).toBeNull();
    expect(revoked?.grantedBy).toBeNull();
    expect(revoked?.ownerDeclaredAt).toBeNull();

    expect(revoked?.lastLoginAt).toBe(lastLoginAfterRelogin);
    const afterRevoke = await store.getAccount(accountId);
    expect(afterRevoke?.lastLoginAt).toBe(lastLoginAfterRelogin);
    expect(afterRevoke?.grantedAt).toBeNull();
  });
});

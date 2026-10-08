import { describe, expect, it } from 'vitest';

import { decodeState, sha256Hex, type AuthStore } from './auth.js';
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

function delayGetAccount(inner: AuthStore, gate: Promise<void>): AuthStore {
  return {
    ...inner,
    getAccount: async (id) => {
      await gate;
      return inner.getAccount(id);
    },
  };
}

describe('AuthService.authenticate と AuthService.logout の競合（issue #1757 の横断レビュー）', () => {
  it('同時に来た authenticate の touch は、ログアウトによる失効を巻き戻さない（issue #1782）', async () => {
    const store = createMemoryStores().auth;
    let counter = 0;
    const service = createAuthService({
      store,
      providers: createAuthProviderRegistry([fakeProvider()]),
      newId: () => `id-${++counter}`,
    });

    const started = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const state = decodeState(new URL(started.authorizationUrl).searchParams.get('state') ?? '');
    const completed = await service.completeLogin({
      state: `${state?.requestId}.${state?.nonce}`,
      code: 'unused',
    });
    expect(completed.status).toBe('ok');
    const claimed = await service.claim({
      requestId: started.requestId,
      claimSecret: started.claimSecret,
    });
    if (claimed.status !== 'ready') throw new Error('ログインできていない');
    await service.grant(claimed.account.id, 'operator');

    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const racingStore = delayGetAccount(store, gate);
    const racingService = createAuthService({
      store: racingStore,
      providers: createAuthProviderRegistry([fakeProvider()]),
      newId: () => `id-${++counter}`,
    });

    const authenticatePromise = racingService.authenticate(claimed.token);

    const logoutResult = await service.logout(claimed.token);
    expect(logoutResult).toEqual({ status: 'ok' });

    const afterLogout = await store.findAccessTokenBySha256(sha256Hex(claimed.token));
    expect(afterLogout?.revokedAt).not.toBeNull();

    releaseGate();
    await authenticatePromise;

    const afterTouch = await store.findAccessTokenBySha256(sha256Hex(claimed.token));
    expect(afterTouch?.revokedAt).not.toBeNull();

    const revived = await service.authenticate(claimed.token);
    expect(revived).toBeNull();
  });

  it('markAccessTokenUsed は lastUsedAt だけを書き、失効済みと無い id には書かない（issue #1782）', async () => {
    const store = createMemoryStores().auth;
    const token = {
      id: 'token-mark',
      accountId: 'account-mark',
      sha256: 'b'.repeat(64),
      label: 'laptop',
      createdAt: '2026-09-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    await store.putAccessToken(token);

    await store.markAccessTokenUsed(token.id, '2026-09-02T00:00:00.000Z');
    const used = await store.findAccessTokenBySha256(token.sha256);
    expect(used?.lastUsedAt).toBe('2026-09-02T00:00:00.000Z');
    expect(used?.revokedAt).toBeNull();

    await store.revokeAccessToken(token.id, '2026-09-03T00:00:00.000Z');
    await store.markAccessTokenUsed(token.id, '2026-09-04T00:00:00.000Z');
    const afterRevoke = await store.findAccessTokenBySha256(token.sha256);
    expect(afterRevoke?.revokedAt).toBe('2026-09-03T00:00:00.000Z');
    expect(afterRevoke?.lastUsedAt).toBe('2026-09-02T00:00:00.000Z');

    await expect(
      store.markAccessTokenUsed('no-such-token', '2026-09-05T00:00:00.000Z'),
    ).resolves.toBeUndefined();
  });
});

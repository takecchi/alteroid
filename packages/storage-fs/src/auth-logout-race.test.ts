import type { AuthStore, OAuthProfile, OAuthProvider } from '@alteroid/core';
import {
  createAuthProviderRegistry,
  createAuthService,
  decodeState,
  sha256Hex,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

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

// オブジェクトスプレッドではなく `Proxy` で被せる: メソッドはプロトタイプ側に在り、スプレッドでは写らないため
function delayGetAccount(inner: AuthStore, gate: Promise<void>): AuthStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'getAccount') {
        return async (id: string) => {
          await gate;
          return target.getAccount(id);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('AuthService.authenticate と AuthService.logout の競合（issue #1782、fs 実装）', () => {
  it('同時に来た authenticate の touch は、ログアウトによる失効を巻き戻さない（issue #1782）', async () => {
    const root = await makeTempDir('alteroid-test-');
    const store = createFsStores(root).auth;
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
    const store = createFsStores(await makeTempDir('alteroid-test-')).auth;
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

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

function delayedAccountWrites(
  inner: AuthStore,
  onRead: () => void,
  writeGate: Promise<void>,
): AuthStore {
  return {
    ...inner,
    getAccount: async (id) => {
      const result = await inner.getAccount(id);
      onRead();
      return result;
    },
    putAccount: async (account) => {
      await writeGate;
      return inner.putAccount(account);
    },
  };
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('AuthService.completeLogin はログイン以外の状態を書き戻さない（issue #1870）', () => {
  it('再ログイン（既存 identity）は、その直前に付与された access grant を消してはいけない', async () => {
    const store = createMemoryStores().auth;
    let counter = 0;
    const providers = createAuthProviderRegistry([fakeProvider()]);
    const service = createAuthService({ store, providers, newId: () => `id-${++counter}` });

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
      newId: () => `id-${++counter}`,
    });

    const reloginPromise = racingService.completeLogin({
      state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
      code: 'unused',
    });

    await read.promise;
    const granted = await service.grant(accountId, 'operator');
    expect(granted.status).toBe('granted');
    expect((await store.getAccount(accountId))?.grantedAt).not.toBeNull();

    write.release();
    const reloginResult = await reloginPromise;
    expect(reloginResult.status).toBe('ok');

    const afterRelogin = await store.getAccount(accountId);
    expect(afterRelogin?.grantedAt).not.toBeNull();
    expect(afterRelogin?.grantedBy).toBe('operator');
  });

  it('再ログイン（既存 identity）は、その直前に取り消された許可・owner宣言を復活させてはいけない', async () => {
    const store = createMemoryStores().auth;
    let counter = 0;
    const providers = createAuthProviderRegistry([fakeProvider()]);
    const service = createAuthService({ store, providers, newId: () => `id-${++counter}` });

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
    expect(beforeRace?.grantedAt).not.toBeNull();

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
      newId: () => `id-${++counter}`,
    });

    const reloginPromise = racingService.completeLogin({
      state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
      code: 'unused',
    });

    await read.promise;
    const revoked = await service.revoke(accountId);
    expect(revoked?.grantedAt).toBeNull();
    expect((await store.getAccount(accountId))?.grantedAt).toBeNull();

    write.release();
    const reloginResult = await reloginPromise;
    expect(reloginResult.status).toBe('ok');

    const afterRelogin = await store.getAccount(accountId);
    expect(afterRelogin?.grantedAt).toBeNull();
  });

  it('同じ identity への同時ログインで負けた側の書き戻しも、その直前に付与された access grant を消してはいけない（#1714 の負け側分岐）', async () => {
    const store = createMemoryStores().auth;
    let counter = 0;
    const providers = createAuthProviderRegistry([fakeProvider()]);
    const service = createAuthService({ store, providers, newId: () => `id-${++counter}` });

    const winnerStart = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const loserStart = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const winnerState = decodeState(
      new URL(winnerStart.authorizationUrl).searchParams.get('state') ?? '',
    );
    const loserState = decodeState(
      new URL(loserStart.authorizationUrl).searchParams.get('state') ?? '',
    );

    const write = gate();
    const read = gate();
    const racingStore = delayedAccountWrites(store, () => read.release(), write.promise);
    const racingService = createAuthService({
      store: racingStore,
      providers,
      newId: () => `id-${++counter}`,
    });

    const winnerPromise = service.completeLogin({
      state: `${winnerState?.requestId}.${winnerState?.nonce}`,
      code: 'unused',
    });
    const loserPromise = racingService.completeLogin({
      state: `${loserState?.requestId}.${loserState?.nonce}`,
      code: 'unused',
    });

    const winnerResult = await winnerPromise;
    expect(winnerResult.status).toBe('ok');
    if (winnerResult.status !== 'ok') throw new Error('ログインできていない');
    const accountId = winnerResult.accountId;

    await read.promise;
    const granted = await service.grant(accountId, 'operator');
    expect(granted.status).toBe('granted');
    expect((await store.getAccount(accountId))?.grantedAt).not.toBeNull();

    write.release();
    const loserResult = await loserPromise;
    expect(loserResult.status).toBe('ok');
    if (loserResult.status !== 'ok') throw new Error('ログインできていない');
    expect(loserResult.accountId).toBe(accountId);

    const afterRace = await store.getAccount(accountId);
    expect(afterRace?.grantedAt).not.toBeNull();
  });
});

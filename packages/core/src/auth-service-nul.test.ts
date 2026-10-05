import { describe, expect, it } from 'vitest';

import { decodeState } from './auth.js';
import { createAuthProviderRegistry, type OAuthProvider } from './auth-providers.js';
import { createAuthService } from './auth-service.js';
import { createMemoryStores } from './testing.js';

/**
 * 認証の境界で NUL を含む値が来たときの結果（issue #3011）。
 * ストアは NUL を含む鍵を「無い」と答える（`auth-nul-contract.ts`）ので、サービスの層では
 * 「一致なし」＝ 資格なし（`authenticate` は null ＝ HTTP の 401）として扱われる。
 * 投げて 500 にならないこと、通ってしまわないことを測る。
 */
function provider(subject: string): OAuthProvider {
  return {
    kind: 'oauth2',
    id: 'fake',
    label: 'Fake',
    authorizationUrl: (request) => `https://example.test/authorize?state=${request.state}`,
    exchange: async () => ({
      subject,
      email: 'a@example.test',
      emailVerified: true,
      displayName: 'A',
    }),
  };
}

function setup(subject: string) {
  const store = createMemoryStores().auth;
  let counter = 0;
  const service = createAuthService({
    store,
    providers: createAuthProviderRegistry([provider(subject)]),
    newId: () => `id-${++counter}`,
  });
  return { store, service };
}

async function start(service: ReturnType<typeof setup>['service']) {
  const started = await service.startLogin({
    provider: 'fake',
    redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
  });
  const state = decodeState(new URL(started.authorizationUrl).searchParams.get('state') ?? '');
  return { started, state: `${state?.requestId}.${state?.nonce}`, requestId: started.requestId };
}

describe('認証の境界の NUL（インメモリ実装）', () => {
  it('NUL を含むアクセストークンは一致なし（authenticate は null ＝ 401）。本物のトークンは通る', async () => {
    const { service } = setup('sub-1');
    const { started, state } = await start(service);
    expect((await service.completeLogin({ state, code: 'c' })).status).toBe('ok');
    const claimed = await service.claim({
      requestId: started.requestId,
      claimSecret: started.claimSecret,
    });
    if (claimed.status !== 'ready') throw new Error('引き取れなかった');
    expect(await service.authenticate(claimed.token)).not.toBeNull();

    expect(await service.authenticate(`${claimed.token}\u0000`)).toBeNull();
    expect(await service.authenticate(`alt_\u0000${claimed.token}`)).toBeNull();
    expect(await service.authenticate('alt_\u0000')).toBeNull();
    expect(await service.logout(`${claimed.token}\u0000`)).toEqual({ status: 'not_found' });
    // 本物は失効されていない
    expect(await service.authenticate(claimed.token)).not.toBeNull();
  });

  it('state の requestId に NUL があれば invalid_state、claim の requestId に NUL があれば invalid_request', async () => {
    const { service } = setup('sub-1');
    const { started, state } = await start(service);
    expect(
      await service.completeLogin({
        state: `${started.requestId}\u0000.${state.split('.')[1]}`,
        code: 'c',
      }),
    ).toEqual({ status: 'error', reason: 'invalid_state' });
    expect(
      await service.claim({
        requestId: `${started.requestId}\u0000`,
        claimSecret: started.claimSecret,
      }),
    ).toEqual({ status: 'error', reason: 'invalid_request' });
  });

  it('許可・取り消しの accountId に NUL があれば「無い」（not_found / null）', async () => {
    const { service } = setup('sub-1');
    expect(await service.grant('x\u0000y', 'operator')).toEqual({ status: 'not_found' });
    expect(await service.revoke('x\u0000y')).toBeNull();
  });

  it('プロバイダの返した subject に NUL があれば、交換の失敗として降りる（アカウントを作らず、投げない）', async () => {
    const { store, service } = setup('sub\u0000nul');
    const { state, requestId } = await start(service);
    expect(await service.completeLogin({ state, code: 'c' })).toEqual({
      status: 'error',
      reason: 'exchange_failed',
    });
    expect(await store.listAccounts()).toEqual([]);
    expect((await store.getLoginRequest(requestId))?.status).toBe('failed');
  });
});

import { describe, expect, it, vi } from 'vitest';

import { decodeState } from './auth.js';
import { createAuthProviderRegistry, type OAuthProvider } from './auth-providers.js';
import { createAuthService } from './auth-service.js';
import { createMemoryStores } from './testing.js';

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

describe('NUL 入りの検証済みメール(インメモリ実装。teto の判断、2026-10-06)', () => {
  it('ログインは exchange_failed で断る(アカウントを作らない)。理由は stderr に残り、メールの値は載らない', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const store = createMemoryStores().auth;
      const service = createAuthService({
        store,
        providers: createAuthProviderRegistry([
          {
            ...provider('sub-ok'),
            exchange: async () => ({
              subject: 'sub-ok',
              email: 'SECRET\u0000@example.test',
              emailVerified: true,
              displayName: 'A',
            }),
          },
        ]),
        newId: () => 'id-1',
      });
      const { state, requestId } = await start(service);
      expect(await service.completeLogin({ state, code: 'c' })).toEqual({
        status: 'error',
        reason: 'exchange_failed',
      });
      expect(await store.listAccounts()).toEqual([]);
      expect((await store.getLoginRequest(requestId))?.status).toBe('failed');
      const log = written.join('');
      expect(log).toContain('auth.email');
      expect(log).toContain('NUL');
      expect(log).not.toContain('SECRET');
    } finally {
      spy.mockRestore();
    }
  });

  it('未検証のメールに NUL があっても、ログインできる(account.email には載せず、identity のメールは落として残す)', async () => {
    const store = createMemoryStores().auth;
    const service = createAuthService({
      store,
      providers: createAuthProviderRegistry([
        {
          ...provider('sub-unv'),
          exchange: async () => ({
            subject: 'sub-unv',
            email: 'a\u0000@example.test',
            emailVerified: false,
            displayName: 'A',
          }),
        },
      ]),
      newId: () => 'id-1',
    });
    const { state } = await start(service);
    expect((await service.completeLogin({ state, code: 'c' })).status).toBe('ok');
    expect((await store.findIdentity('fake', 'sub-unv'))?.email).toBe('a@example.test');
  });
});

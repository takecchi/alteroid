import { describe, expect, it, vi } from 'vitest';

import { decodeState } from './auth.js';
import { createAuthProviderRegistry, type OAuthProvider } from './auth-providers.js';
import { createAuthService } from './auth-service.js';
import type { AuthStore } from './auth.js';
import { createMemoryStores } from './testing.js';

/**
 * 交換の後の器の操作が例外を投げても、要求を `processing` のまま残さない（issue #3771）。
 * 残すと端末の `claim` は TTL まで `pending` を受け取り続け、最後に `expired` と言われる。
 */
const provider: OAuthProvider = {
  kind: 'oauth2',
  id: 'fake',
  label: 'Fake',
  authorizationUrl: (request) => `https://example.test/authorize?state=${request.state}`,
  exchange: async () => ({
    subject: 'sub-1',
    email: 'a@example.test',
    emailVerified: true,
    displayName: 'A',
  }),
};

type FlakyOperation = 'findIdentity' | 'createAccountWithIdentity' | 'putLoginRequest';

/** 指定した操作を、`completeLogin` の交換の後で最初に呼ばれたとき一度だけ投げさせる。 */
function setup(flaky: FlakyOperation) {
  const inner = createMemoryStores().auth;
  let armed = false;
  let thrown = false;
  const store: AuthStore = {
    ...inner,
    async beginLoginExchange(id) {
      const claimed = await inner.beginLoginExchange(id);
      armed = true;
      return claimed;
    },
    async findIdentity(...args) {
      if (armed && flaky === 'findIdentity' && !thrown) {
        thrown = true;
        throw new Error('store down');
      }
      return inner.findIdentity(...args);
    },
    async createAccountWithIdentity(...args) {
      if (armed && flaky === 'createAccountWithIdentity' && !thrown) {
        thrown = true;
        throw new Error('store down');
      }
      return inner.createAccountWithIdentity(...args);
    },
    async putLoginRequest(request) {
      // 最後の `authenticated` の書き込みだけ落とす（`failed` への書き込みは通す）。
      if (flaky === 'putLoginRequest' && request.status === 'authenticated' && !thrown) {
        thrown = true;
        throw new Error('store down');
      }
      return inner.putLoginRequest(request);
    },
  };
  let counter = 0;
  const service = createAuthService({
    store,
    providers: createAuthProviderRegistry([provider]),
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
  return { started, state: `${state?.requestId}.${state?.nonce}` };
}

describe('交換の後の器の失敗（issue #3771）', () => {
  it.each<FlakyOperation>(['findIdentity', 'createAccountWithIdentity', 'putLoginRequest'])(
    '%s が一度投げても、exchange_failed を返し、要求は failed になり、claim は failed を返す',
    async (operation) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { store, service } = setup(operation);
        const { started, state } = await start(service);

        expect(await service.completeLogin({ state, code: 'c' })).toEqual({
          status: 'error',
          reason: 'exchange_failed',
        });
        const saved = await store.getLoginRequest(started.requestId);
        expect(saved?.status).toBe('failed');
        expect(saved?.error).toBe('exchange_failed');
        expect(
          await service.claim({
            requestId: started.requestId,
            claimSecret: started.claimSecret,
          }),
        ).toEqual({ status: 'error', reason: 'failed' });
      } finally {
        stderr.mockRestore();
      }
    },
  );

  it('failed への書き込みまで投げたら、stderr に1行出して exchange_failed を返す（例外は外へ出さない）', async () => {
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const inner = createMemoryStores().auth;
      let armed = false;
      const store: AuthStore = {
        ...inner,
        async beginLoginExchange(id) {
          const claimed = await inner.beginLoginExchange(id);
          armed = true;
          return claimed;
        },
        async findIdentity() {
          throw new Error('store down');
        },
        async putLoginRequest(request) {
          if (armed) throw new Error('store down');
          return inner.putLoginRequest(request);
        },
      };
      const service = createAuthService({
        store,
        providers: createAuthProviderRegistry([provider]),
        newId: () => 'id-1',
      });
      const { state } = await start(service);
      expect(await service.completeLogin({ state, code: 'c' })).toEqual({
        status: 'error',
        reason: 'exchange_failed',
      });
      expect(written.join('')).toContain('failed に落とせなかった');
    } finally {
      stderr.mockRestore();
    }
  });
});

import { describe, expect, it } from 'vitest';

import { decodeState } from './auth.js';
import { createAuthProviderRegistry, type OAuthProfile, type OAuthProvider } from './auth-providers.js';
import { createAuthService } from './auth-service.js';
import { createMemoryStores } from './testing.js';

/**
 * 候補: claim() は `authenticated` 状態になった後は `isLoginRequestOpen` を
 * 一度も見ない。ブラウザ側の callback が TTL 内に終わっていれば、その後
 * 何時間・何日経っても claimSecret さえ合えばアクセストークンを発行できて
 * しまうように見える。startLogin の doc は「ブラウザ往復に必要な分だけ開ける」
 * と言っているので、これは意図と食い違う可能性がある。
 */

function fakeProvider(profiles: Record<string, OAuthProfile>): OAuthProvider {
  return {
    kind: 'oauth2',
    id: 'fake',
    label: 'Fake',
    authorizationUrl: (request) => `https://example.test/authorize?state=${request.state}`,
    exchange: async ({ code }) => {
      const profile = profiles[code];
      if (profile === undefined) throw new Error(`未知の code: ${code}`);
      return profile;
    },
  };
}

const ALICE: OAuthProfile = {
  subject: 'sub-alice',
  email: 'alice@example.test',
  emailVerified: true,
  displayName: 'Alice',
};

describe('claim() と login request の TTL（候補・赤取り用）', () => {
  it('authenticated になった後は、ログイン要求の期限が切れていても claim できてしまう', async () => {
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const store = createMemoryStores().auth;
    let counter = 0;
    const service = createAuthService({
      store,
      providers: createAuthProviderRegistry([fakeProvider({ 'code-alice': ALICE })]),
      newId: () => `id-${++counter}`,
      now: () => clock,
      // ログイン要求は60秒だけ開ける、という設定。
      loginTtlSeconds: 60,
    });

    const started = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const state = decodeState(new URL(started.authorizationUrl).searchParams.get('state') ?? '');

    // ブラウザ側は TTL 内（10秒後）に戻ってくる。
    clock = new Date(clock.getTime() + 10_000);
    const completed = await service.completeLogin({
      state: `${state?.requestId}.${state?.nonce}`,
      code: 'code-alice',
    });
    expect(completed.status).toBe('ok');

    // ところが CLI 側の claim は、TTL(60秒) をとっくに超えた1時間後に来た。
    clock = new Date(clock.getTime() + 3_600_000);

    const claimed = await service.claim({
      requestId: started.requestId,
      claimSecret: started.claimSecret,
    });

    // 期待: TTL を過ぎているので claim は失敗するはず。
    expect(claimed.status).toBe('error');
  });
});

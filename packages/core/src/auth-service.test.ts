import { beforeEach, describe, expect, it } from 'vitest';

import {
  decodeState,
  isAccountGranted,
  isDeclaredOwner,
  type AuthAccount,
  type AuthStore,
} from './auth.js';
import {
  createAuthProviderRegistry,
  type OAuthProfile,
  type OAuthProvider,
} from './auth-providers.js';
import { createAuthService, type AuthService } from './auth-service.js';
import { createMemoryStores } from './testing.js';

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

function brokenTokenStore(inner: AuthStore): AuthStore {
  return {
    ...inner,
    claimLoginRequest: () => Promise.reject(new Error('器が落ちた')),
  };
}

const ALICE: OAuthProfile = {
  subject: 'sub-alice',
  email: 'alice@example.test',
  emailVerified: true,
  displayName: 'Alice',
};

describe('createAuthService', () => {
  let store: AuthStore;
  let service: AuthService;
  let counter: number;

  beforeEach(() => {
    store = createMemoryStores().auth;
    counter = 0;
    service = createAuthService({
      store,
      providers: createAuthProviderRegistry([
        fakeProvider({
          'code-alice': ALICE,
          'code-bob': {
            subject: 'sub-bob',
            email: 'bob@example.test',
            emailVerified: true,
            displayName: 'Bob',
          },
          'code-carol': {
            subject: 'sub-carol',
            email: 'carol@example.test',
            emailVerified: true,
            displayName: 'Carol',
          },
          'code-impostor': {
            subject: 'sub-impostor',
            email: 'alice@example.test',
            emailVerified: true,
            displayName: 'Not Alice',
          },
          'code-impostor-case': {
            subject: 'sub-impostor-case',
            email: 'ALICE@EXAMPLE.TEST',
            emailVerified: true,
            displayName: 'Not Alice (case)',
          },
          'code-impostor-samecase': {
            subject: 'sub-impostor-samecase',
            email: 'alice@example.test',
            emailVerified: true,
            displayName: 'Not Alice (same case)',
          },
        }),
      ]),
      newId: () => `id-${++counter}`,
    });
  });

  async function login(code: string): Promise<{ requestId: string; claimSecret: string }> {
    const started = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const state = decodeState(new URL(started.authorizationUrl).searchParams.get('state') ?? '');
    expect(state).not.toBeNull();
    const completed = await service.completeLogin({
      state: `${state?.requestId}.${state?.nonce}`,
      code,
    });
    expect(completed.status).toBe('ok');
    return { requestId: started.requestId, claimSecret: started.claimSecret };
  }

  it('ログインしただけでは alteroid を使う許可が無い（受け入れの中心）', async () => {
    const { requestId, claimSecret } = await login('code-alice');

    const claimed = await service.claim({ requestId, claimSecret });
    expect(claimed.status).toBe('ready');
    if (claimed.status !== 'ready') return;

    expect(isAccountGranted(claimed.account)).toBe(false);

    const authenticated = await service.authenticate(claimed.token);
    expect(authenticated).not.toBeNull();
    expect(isAccountGranted(authenticated!)).toBe(false);
  });

  it('許可を与えると使えるようになり、取り消すと同じトークンで使えなくなる', async () => {
    const { requestId, claimSecret } = await login('code-alice');
    const claimed = await service.claim({ requestId, claimSecret });
    if (claimed.status !== 'ready') throw new Error('ログインできていない');

    expect(await service.grant(claimed.account.id, 'operator')).toMatchObject({
      status: 'granted',
    });
    expect(isAccountGranted((await service.authenticate(claimed.token))!)).toBe(true);

    await service.revoke(claimed.account.id);
    expect(isAccountGranted((await service.authenticate(claimed.token))!)).toBe(false);
  });

  it('複数のアカウントを許可できる（分けないのはデータの側）', async () => {
    const alice = await service.claim(await login('code-alice'));
    const bob = await service.claim(await login('code-bob'));
    if (alice.status !== 'ready' || bob.status !== 'ready') throw new Error('ログインできていない');

    expect(await service.grant(alice.account.id, 'operator')).toMatchObject({ status: 'granted' });
    expect(await service.grant(bob.account.id, 'operator')).toMatchObject({ status: 'granted' });
    expect(isAccountGranted((await service.authenticate(alice.token))!)).toBe(true);
    expect(isAccountGranted((await service.authenticate(bob.token))!)).toBe(true);

    await service.revoke(alice.account.id);
    expect(isAccountGranted((await service.authenticate(alice.token))!)).toBe(false);
    expect(isAccountGranted((await service.authenticate(bob.token))!)).toBe(true);
  });

  it('同じアカウントへ同時に grant しても、grantedBy は先に書いた側のまま', async () => {
    const alice = await service.claim(await login('code-alice'));
    const bob = await service.claim(await login('code-bob'));
    if (alice.status !== 'ready' || bob.status !== 'ready') throw new Error('ログインできていない');

    const separate = await Promise.all([
      service.grant(alice.account.id, 'operator'),
      service.grant(bob.account.id, 'operator'),
    ]);
    expect(separate.filter((result) => result.status === 'granted')).toHaveLength(2);
    expect((await service.grantedAccounts()).map((account) => account.id).sort()).toEqual(
      [alice.account.id, bob.account.id].sort(),
    );

    const carol = await service.claim(await login('code-carol'));
    if (carol.status !== 'ready') throw new Error('ログインできていない');
    const same = await Promise.all([
      service.grant(carol.account.id, 'operator'),
      service.grant(carol.account.id, alice.account.id),
    ]);
    expect(same.every((result) => result.status === 'granted')).toBe(true);

    const stored = (await service.listAccounts()).find(
      (account) => account.id === carol.account.id,
    );
    const reported = same.map((result) =>
      result.status === 'granted' ? result.account.grantedBy : null,
    );
    expect(reported).toEqual([stored?.grantedBy, stored?.grantedBy]);
  });

  it('トークンの保存に失敗したら、同じログインをもう一度引き取れる', async () => {
    const failing = createAuthService({
      store: brokenTokenStore(store),
      providers: createAuthProviderRegistry([fakeProvider({ 'code-alice': ALICE })]),
      newId: () => `id-${++counter}`,
    });
    const started = await failing.startLogin({ provider: 'fake', redirectUri: 'http://x/cb' });
    const state = decodeState(new URL(started.authorizationUrl).searchParams.get('state') ?? '');
    await failing.completeLogin({
      state: `${state?.requestId}.${state?.nonce}`,
      code: 'code-alice',
    });

    await expect(
      failing.claim({ requestId: started.requestId, claimSecret: started.claimSecret }),
    ).rejects.toThrow();

    const recovered = await service.claim({
      requestId: started.requestId,
      claimSecret: started.claimSecret,
    });
    expect(recovered.status).toBe('ready');
  });

  it('grantedAccounts() は許可されているアカウントを全部返す', async () => {
    expect(await service.grantedAccounts()).toEqual([]);
    const alice = await service.claim(await login('code-alice'));
    const bob = await service.claim(await login('code-bob'));
    if (alice.status !== 'ready' || bob.status !== 'ready') throw new Error('ログインできていない');

    await service.grant(alice.account.id, 'operator');
    expect((await service.grantedAccounts()).map((account) => account.id)).toEqual([
      alice.account.id,
    ]);

    await service.grant(bob.account.id, 'operator');
    expect((await service.grantedAccounts()).map((account) => account.id).sort()).toEqual(
      [alice.account.id, bob.account.id].sort(),
    );

    await service.revoke(alice.account.id);
    expect((await service.grantedAccounts()).map((account) => account.id)).toEqual([
      bob.account.id,
    ]);
  });

  it('検証済みメールが一致しても既存アカウントへ相乗りさせない', async () => {
    const alice = await login('code-alice');
    const claimedAlice = await service.claim(alice);
    if (claimedAlice.status !== 'ready') throw new Error('ログインできていない');
    await service.grant(claimedAlice.account.id, 'operator');

    const impostor = await login('code-impostor');
    const claimedImpostor = await service.claim(impostor);
    if (claimedImpostor.status !== 'ready') throw new Error('ログインできていない');

    expect(claimedImpostor.account.id).not.toBe(claimedAlice.account.id);
    expect(isAccountGranted(claimedImpostor.account)).toBe(false);
    expect(claimedImpostor.account.email).toBeNull();
  });

  it('大小文字だけが違う検証済みメールも衝突として検出し、2つ目のアカウントには乗せない（#1702）', async () => {
    const alice = await login('code-alice');
    const claimedAlice = await service.claim(alice);
    if (claimedAlice.status !== 'ready') throw new Error('ログインできていない');
    expect(claimedAlice.account.email).toBe('alice@example.test');

    const impostorCase = await login('code-impostor-case');
    const claimedImpostorCase = await service.claim(impostorCase);
    if (claimedImpostorCase.status !== 'ready') throw new Error('ログインできていない');

    expect(claimedImpostorCase.account.id).not.toBe(claimedAlice.account.id);
    expect(claimedImpostorCase.account.email).toBeNull();
  });

  it('同じ identity で入り直しても同じアカウントで、許可は保たれる', async () => {
    const first = await login('code-alice');
    const claimedFirst = await service.claim(first);
    if (claimedFirst.status !== 'ready') throw new Error('ログインできていない');
    await service.grant(claimedFirst.account.id, 'operator');

    const second = await login('code-alice');
    const claimedSecond = await service.claim(second);
    if (claimedSecond.status !== 'ready') throw new Error('ログインできていない');

    expect(claimedSecond.account.id).toBe(claimedFirst.account.id);
    expect(isAccountGranted(claimedSecond.account)).toBe(true);
    expect(claimedSecond.token).not.toBe(claimedFirst.token);
    expect(await service.authenticate(claimedFirst.token)).not.toBeNull();
  });

  it('同じ identity で2つのログインが同時に完了しても、アカウントは1つで両方が同じ accountId になる（#1714）', async () => {
    const first = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const second = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const stateFirst = decodeState(new URL(first.authorizationUrl).searchParams.get('state') ?? '');
    const stateSecond = decodeState(
      new URL(second.authorizationUrl).searchParams.get('state') ?? '',
    );
    expect(stateFirst).not.toBeNull();
    expect(stateSecond).not.toBeNull();

    const [resultA, resultB] = await Promise.all([
      service.completeLogin({
        state: `${stateFirst?.requestId}.${stateFirst?.nonce}`,
        code: 'code-alice',
      }),
      service.completeLogin({
        state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
        code: 'code-alice',
      }),
    ]);

    expect(resultA.status).toBe('ok');
    expect(resultB.status).toBe('ok');
    if (resultA.status !== 'ok' || resultB.status !== 'ok') {
      throw new Error('ログインできていない');
    }
    expect(resultA.accountId).toBe(resultB.accountId);

    const accounts = await store.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(await store.listIdentities(resultA.accountId)).toHaveLength(1);
  });

  it('r2: 別々の identity が大小文字だけ違う検証済みメールで同時にログインしても、検証済みメールを持つアカウントは1つだけ', async () => {
    const first = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const second = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const stateFirst = decodeState(new URL(first.authorizationUrl).searchParams.get('state') ?? '');
    const stateSecond = decodeState(
      new URL(second.authorizationUrl).searchParams.get('state') ?? '',
    );
    expect(stateFirst).not.toBeNull();
    expect(stateSecond).not.toBeNull();

    const [resultA, resultB] = await Promise.all([
      service.completeLogin({
        state: `${stateFirst?.requestId}.${stateFirst?.nonce}`,
        code: 'code-alice',
      }),
      service.completeLogin({
        state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
        code: 'code-impostor-case',
      }),
    ]);

    expect(resultA.status).toBe('ok');
    expect(resultB.status).toBe('ok');
    if (resultA.status !== 'ok' || resultB.status !== 'ok') {
      throw new Error('ログインできていない');
    }
    expect(resultA.accountId).not.toBe(resultB.accountId);

    const accounts = await store.listAccounts();
    expect(accounts).toHaveLength(2);
    const withVerifiedEmail = accounts.filter((account) => account.email !== null);
    expect(withVerifiedEmail).toHaveLength(1);
  });

  it('#1741: 別々の identity が大小文字まで同じ検証済みメールで同時にログインしても、検証済みメールを持つアカウントは1つだけ', async () => {
    const first = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const second = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const stateFirst = decodeState(new URL(first.authorizationUrl).searchParams.get('state') ?? '');
    const stateSecond = decodeState(
      new URL(second.authorizationUrl).searchParams.get('state') ?? '',
    );
    expect(stateFirst).not.toBeNull();
    expect(stateSecond).not.toBeNull();

    const [resultA, resultB] = await Promise.all([
      service.completeLogin({
        state: `${stateFirst?.requestId}.${stateFirst?.nonce}`,
        code: 'code-alice',
      }),
      service.completeLogin({
        state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
        code: 'code-impostor-samecase',
      }),
    ]);

    expect(resultA.status).toBe('ok');
    expect(resultB.status).toBe('ok');
    if (resultA.status !== 'ok' || resultB.status !== 'ok') {
      throw new Error('ログインできていない');
    }
    expect(resultA.accountId).not.toBe(resultB.accountId);

    const accounts = await store.listAccounts();
    expect(accounts).toHaveLength(2);
    const withVerifiedEmail = accounts.filter((account) => account.email !== null);
    expect(withVerifiedEmail).toHaveLength(1);
  });

  it('createAccountWithIdentity を別々の identity・同じ候補メールで並行に呼んでも、投げずにメールが載るのは1つだけ', async () => {
    const makeInput = (accountId: string, subject: string) => ({
      account: {
        id: accountId,
        displayName: 'Someone',
        email: 'shared@example.test',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
        grantedAt: null,
        grantedBy: null,
        ownerDeclaredAt: null,
      },
      identity: {
        provider: 'google',
        subject,
        accountId,
        email: 'shared@example.test',
        emailVerified: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const results = await Promise.all([
      store.createAccountWithIdentity(makeInput('account-diff-identity-a', 'sub-diff-a')),
      store.createAccountWithIdentity(makeInput('account-diff-identity-b', 'sub-diff-b')),
    ]);

    expect(results.every((result) => result.created)).toBe(true);
    const emails = results.map((result) => (result.created ? result.account.email : null));
    expect(emails.filter((email) => email !== null)).toHaveLength(1);

    const accounts = (await store.listAccounts()).filter((it) =>
      it.id.startsWith('account-diff-identity-'),
    );
    expect(accounts).toHaveLength(2);
    expect(accounts.filter((it) => it.email !== null)).toHaveLength(1);
  });

  it('同じ claim を並行に投げても、有効なトークンは1本しか出ない', async () => {
    const { requestId, claimSecret } = await login('code-alice');

    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.claim({ requestId, claimSecret })),
    );

    const ready = results.filter((result) => result.status === 'ready');
    expect(ready).toHaveLength(1);

    const first = ready[0];
    if (first?.status !== 'ready') throw new Error('ready が無い');
    expect(await store.listAccessTokens(first.account.id)).toHaveLength(1);
  });

  it('同じ callback が並行に届いても、交換は1回だけで成功が失敗に上書きされない', async () => {
    let exchanges = 0;
    const oneTimeCode = createAuthService({
      store,
      newId: () => `id-${++counter}`,
      providers: createAuthProviderRegistry([
        {
          kind: 'oauth2',
          id: 'fake',
          label: 'Fake',
          authorizationUrl: (request) => `https://example.test/authorize?state=${request.state}`,
          exchange: async () => {
            exchanges += 1;
            if (exchanges > 1) throw new Error('invalid_grant');
            return ALICE;
          },
        },
      ]),
    });

    const started = await oneTimeCode.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';

    const results = await Promise.all([
      oneTimeCode.completeLogin({ state, code: 'code-alice' }),
      oneTimeCode.completeLogin({ state, code: 'code-alice' }),
      oneTimeCode.completeLogin({ state, code: 'code-alice' }),
    ]);

    expect(exchanges).toBe(1);
    expect(results.filter((result) => result.status === 'ok')).toHaveLength(1);

    const claimed = await oneTimeCode.claim({
      requestId: started.requestId,
      claimSecret: started.claimSecret,
    });
    expect(claimed.status).toBe('ready');
  });

  it('交換中（processing）の引き取りは pending として待たせる', async () => {
    const started = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    await store.beginLoginExchange(started.requestId);

    const result = await service.claim({
      requestId: started.requestId,
      claimSecret: started.claimSecret,
    });
    expect(result).toEqual({ status: 'pending' });
  });

  it('引き取りは一度きり（二度目は盗まれた可能性として拒む）', async () => {
    const { requestId, claimSecret } = await login('code-alice');
    expect((await service.claim({ requestId, claimSecret })).status).toBe('ready');

    const again = await service.claim({ requestId, claimSecret });
    expect(again.status).toBe('error');
  });

  it('claimSecret が違えばトークンを渡さない', async () => {
    const { requestId } = await login('code-alice');
    const result = await service.claim({ requestId, claimSecret: 'でたらめ' });
    expect(result).toEqual({ status: 'error', reason: 'invalid_secret' });
  });

  it('ブラウザ側が終わっていなければ pending（端末は待てばよい）', async () => {
    const started = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const result = await service.claim({
      requestId: started.requestId,
      claimSecret: started.claimSecret,
    });
    expect(result).toEqual({ status: 'pending' });
  });

  describe('claim() と要求の TTL（authenticated になった後）', () => {
    function buildExpiringService(loginTtlSeconds: number) {
      const clockBox = { now: new Date('2026-01-01T00:00:00.000Z') };
      const expiring = createAuthService({
        store,
        providers: createAuthProviderRegistry([fakeProvider({ 'code-alice': ALICE })]),
        newId: () => `id-${++counter}`,
        now: () => clockBox.now,
        loginTtlSeconds,
      });
      return { expiring, clockBox };
    }

    async function loginThrough(expiring: AuthService) {
      const started = await expiring.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const state = decodeState(new URL(started.authorizationUrl).searchParams.get('state') ?? '');
      const completed = await expiring.completeLogin({
        state: `${state?.requestId}.${state?.nonce}`,
        code: 'code-alice',
      });
      expect(completed.status).toBe('ok');
      return started;
    }

    it('ブラウザは TTL 内に終えても、CLI の引き取りが TTL を過ぎていれば claim できない', async () => {
      const { expiring, clockBox } = buildExpiringService(60);
      const started = await loginThrough(expiring);

      clockBox.now = new Date(clockBox.now.getTime() + 10_000 + 3_600_000);

      const claimed = await expiring.claim({
        requestId: started.requestId,
        claimSecret: started.claimSecret,
      });
      expect(claimed).toEqual({ status: 'error', reason: 'expired' });
    });

    it('境界: expiresAt ちょうどは閉じている（isLoginRequestOpen は `>` なので期限切れ扱い）', async () => {
      const { expiring, clockBox } = buildExpiringService(60);
      const started = await loginThrough(expiring);

      clockBox.now = new Date(Date.parse(started.expiresAt));
      const claimed = await expiring.claim({
        requestId: started.requestId,
        claimSecret: started.claimSecret,
      });
      expect(claimed).toEqual({ status: 'error', reason: 'expired' });
    });

    it('境界: expiresAt の1ms前はまだ開いている（claim できる）', async () => {
      const { expiring, clockBox } = buildExpiringService(60);
      const started = await loginThrough(expiring);

      clockBox.now = new Date(Date.parse(started.expiresAt) - 1);
      const claimed = await expiring.claim({
        requestId: started.requestId,
        claimSecret: started.claimSecret,
      });
      expect(claimed.status).toBe('ready');
    });

    it('期限切れでも要求を failed へは書き換えない（pending/processing の期限切れと同じ「書かずに返す」扱い）', async () => {
      const { expiring, clockBox } = buildExpiringService(60);
      const started = await loginThrough(expiring);

      clockBox.now = new Date(clockBox.now.getTime() + 3_600_000);
      await expiring.claim({ requestId: started.requestId, claimSecret: started.claimSecret });

      const stored = await store.getLoginRequest(started.requestId);
      expect(stored?.status).toBe('authenticated');
      expect(stored?.error).toBeNull();
    });

    it('優先順位は変わらない: 期限切れの前に引き取り済み（consumed）なら、期限切れではなく従来どおり invalid_request', async () => {
      const { expiring, clockBox } = buildExpiringService(60);
      const started = await loginThrough(expiring);

      const first = await expiring.claim({
        requestId: started.requestId,
        claimSecret: started.claimSecret,
      });
      expect(first.status).toBe('ready');

      clockBox.now = new Date(clockBox.now.getTime() + 3_600_000);
      const second = await expiring.claim({
        requestId: started.requestId,
        claimSecret: started.claimSecret,
      });
      expect(second).toEqual({ status: 'error', reason: 'invalid_request' });
    });
  });

  it('state が偽物ならログインを成立させない', async () => {
    await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const result = await service.completeLogin({ state: 'id-1.でたらめ', code: 'code-alice' });
    expect(result).toEqual({ status: 'error', reason: 'invalid_state' });
  });

  it('期限切れのトークンでは認証されない', async () => {
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const expiring = createAuthService({
      store,
      providers: createAuthProviderRegistry([fakeProvider({ 'code-alice': ALICE })]),
      newId: () => `id-${++counter}`,
      now: () => clock,
      tokenTtlDays: 1,
    });

    const started = await expiring.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const state = decodeState(new URL(started.authorizationUrl).searchParams.get('state') ?? '');
    await expiring.completeLogin({
      state: `${state?.requestId}.${state?.nonce}`,
      code: 'code-alice',
    });
    const claimed = await expiring.claim({
      requestId: started.requestId,
      claimSecret: started.claimSecret,
    });
    if (claimed.status !== 'ready') throw new Error('ログインできていない');

    expect(await expiring.authenticate(claimed.token)).not.toBeNull();
    clock = new Date('2026-01-03T00:00:00.000Z');
    expect(await expiring.authenticate(claimed.token)).toBeNull();
  });

  it('素のトークンをストアに残さない（漏れた保管先から再利用できない）', async () => {
    const { requestId, claimSecret } = await login('code-alice');
    const claimed = await service.claim({ requestId, claimSecret });
    if (claimed.status !== 'ready') throw new Error('ログインできていない');

    const stored = await store.listAccessTokens(claimed.account.id);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(claimed.token);
  });

  it('でたらめなトークンでは認証されない', async () => {
    expect(await service.authenticate('alt_でたらめ')).toBeNull();
    expect(await service.authenticate('接頭辞すら違う')).toBeNull();
  });

  describe('logout', () => {
    it('提示したトークンだけを失効させ、以後は authenticate が通らない', async () => {
      const { requestId, claimSecret } = await login('code-alice');
      const claimed = await service.claim({ requestId, claimSecret });
      if (claimed.status !== 'ready') throw new Error('ログインできていない');

      const result = await service.logout(claimed.token);
      expect(result).toEqual({ status: 'ok' });
      expect(await service.authenticate(claimed.token)).toBeNull();
    });

    it('同じアカウントの別のトークンは巻き込まない（アカウント単位ではなくトークン単位）', async () => {
      const { requestId, claimSecret } = await login('code-alice');
      const claimed = await service.claim({ requestId, claimSecret });
      if (claimed.status !== 'ready') throw new Error('ログインできていない');

      const second = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const state = decodeState(new URL(second.authorizationUrl).searchParams.get('state') ?? '');
      await service.completeLogin({
        state: `${state?.requestId}.${state?.nonce}`,
        code: 'code-alice',
      });
      const secondClaimed = await service.claim({
        requestId: second.requestId,
        claimSecret: second.claimSecret,
      });
      if (secondClaimed.status !== 'ready') throw new Error('2本目のログインができていない');
      expect(secondClaimed.account.id).toBe(claimed.account.id);

      await service.logout(claimed.token);

      expect(await service.authenticate(claimed.token)).toBeNull();
      expect(await service.authenticate(secondClaimed.token)).not.toBeNull();
    });

    it('もう一度ログアウトしても ok のまま（冪等——二度目の呼び出しで落ちない）', async () => {
      const { requestId, claimSecret } = await login('code-alice');
      const claimed = await service.claim({ requestId, claimSecret });
      if (claimed.status !== 'ready') throw new Error('ログインできていない');

      await service.logout(claimed.token);
      expect(await service.logout(claimed.token)).toEqual({ status: 'ok' });
    });

    it('でたらめなトークンでは not_found', async () => {
      expect(await service.logout('alt_でたらめ')).toEqual({ status: 'not_found' });
    });
  });
});

describe('listAccounts / listIdentities / listAccessTokens の並び（in-memory、issue #1676）', () => {
  it('listAccounts は createdAt の実時刻順（オフセット表記が違っても崩れない）', async () => {
    const memoryAuth = createMemoryStores().auth;
    const base = {
      displayName: null,
      email: null,
      lastLoginAt: null,
      grantedAt: null,
      grantedBy: null,
      ownerDeclaredAt: null,
    };
    const early = {
      ...base,
      id: 'account-early-utc',
      createdAt: '2024-01-01T23:00:00+09:00',
    };
    const late = {
      ...base,
      id: 'account-late-utc',
      createdAt: '2024-01-01T15:00:00+00:00',
    };
    await memoryAuth.putAccount(early);
    await memoryAuth.putAccount(late);

    const ids = (await memoryAuth.listAccounts()).map((it) => it.id);
    expect(ids).toEqual(['account-early-utc', 'account-late-utc']);
  });

  it('listIdentities は createdAt の実時刻順で返す', async () => {
    const memoryAuth = createMemoryStores().auth;
    await memoryAuth.putAccount({
      id: 'account-1',
      displayName: null,
      email: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
      grantedAt: null,
      grantedBy: null,
      ownerDeclaredAt: null,
    });
    const first = {
      provider: 'google',
      subject: 'sub-first',
      accountId: 'account-1',
      email: 'first@example.test',
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-01-01T00:00:00.000Z',
    };
    const second = {
      provider: 'google',
      subject: 'sub-second',
      accountId: 'account-1',
      email: 'second@example.test',
      emailVerified: true,
      createdAt: '2026-01-02T00:00:00.000Z',
      lastLoginAt: '2026-01-02T00:00:00.000Z',
    };
    await memoryAuth.putIdentity(second);
    await memoryAuth.putIdentity(first);

    const subjects = (await memoryAuth.listIdentities('account-1')).map((it) => it.subject);
    expect(subjects).toEqual(['sub-first', 'sub-second']);
  });

  it('listAccessTokens は createdAt の実時刻順で返す', async () => {
    const memoryAuth = createMemoryStores().auth;
    await memoryAuth.putAccount({
      id: 'account-1',
      displayName: null,
      email: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
      grantedAt: null,
      grantedBy: null,
      ownerDeclaredAt: null,
    });
    const first = {
      id: 'token-first',
      accountId: 'account-1',
      sha256: 'a'.repeat(64),
      label: 'first',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    const second = {
      id: 'token-second',
      accountId: 'account-1',
      sha256: 'b'.repeat(64),
      label: 'second',
      createdAt: '2026-01-02T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    await memoryAuth.putAccessToken(second);
    await memoryAuth.putAccessToken(first);

    const ids = (await memoryAuth.listAccessTokens('account-1')).map((it) => it.id);
    expect(ids).toEqual(['token-first', 'token-second']);
  });
});

describe('同着（createdAt が同一）の並び（in-memory、issue #1688）', () => {
  const TIE = '2026-01-05T00:00:00.000Z';
  const account = {
    id: 'account-1',
    displayName: null,
    email: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    grantedAt: null,
    grantedBy: null,
    ownerDeclaredAt: null,
  };

  it('listAccounts: 同着の2行のうち先に作ったほうだけ後から更新すると、id 昇順のまま動かない', async () => {
    const memoryAuth = createMemoryStores().auth;
    const first = { ...account, id: 'account-a', email: 'a@example.test', createdAt: TIE };
    const second = { ...account, id: 'account-b', email: 'b@example.test', createdAt: TIE };
    await memoryAuth.putAccount(first);
    await memoryAuth.putAccount(second);
    await memoryAuth.putAccount({ ...first, displayName: 'renamed' });

    const ids = (await memoryAuth.listAccounts()).map((it) => it.id);
    expect(ids).toEqual(['account-a', 'account-b']);
  });

  it('listAccounts: 同着2行を2次キー（id）と逆順に挿入しても、id 昇順で返る', async () => {
    const memoryAuth = createMemoryStores().auth;
    const first = { ...account, id: 'account-z', email: 'z@example.test', createdAt: TIE };
    const second = { ...account, id: 'account-a', email: 'a@example.test', createdAt: TIE };
    await memoryAuth.putAccount(first);
    await memoryAuth.putAccount(second);

    const ids = (await memoryAuth.listAccounts()).map((it) => it.id);
    expect(ids).toEqual(['account-a', 'account-z']);
  });

  it('listIdentities: 同着の2行のうち先に作ったほうだけ後から更新すると、(provider, subject) 昇順のまま動かない', async () => {
    const memoryAuth = createMemoryStores().auth;
    await memoryAuth.putAccount(account);
    const first = {
      provider: 'google',
      subject: 'sub-first',
      accountId: 'account-1',
      email: 'first@example.test',
      emailVerified: true,
      createdAt: TIE,
      lastLoginAt: TIE,
    };
    const second = {
      provider: 'google',
      subject: 'sub-second',
      accountId: 'account-1',
      email: 'second@example.test',
      emailVerified: true,
      createdAt: TIE,
      lastLoginAt: TIE,
    };
    await memoryAuth.putIdentity(first);
    await memoryAuth.putIdentity(second);
    await memoryAuth.putIdentity({ ...first, lastLoginAt: '2026-01-06T00:00:00.000Z' });

    const subjects = (await memoryAuth.listIdentities('account-1')).map((it) => it.subject);
    expect(subjects).toEqual(['sub-first', 'sub-second']);
  });

  it('listIdentities: 同着2行を2次キー（subject）と逆順に挿入しても、subject 昇順で返る', async () => {
    const memoryAuth = createMemoryStores().auth;
    await memoryAuth.putAccount(account);
    const first = {
      provider: 'google',
      subject: 'sub-z',
      accountId: 'account-1',
      email: 'z@example.test',
      emailVerified: true,
      createdAt: TIE,
      lastLoginAt: TIE,
    };
    const second = {
      provider: 'google',
      subject: 'sub-a',
      accountId: 'account-1',
      email: 'a@example.test',
      emailVerified: true,
      createdAt: TIE,
      lastLoginAt: TIE,
    };
    await memoryAuth.putIdentity(first);
    await memoryAuth.putIdentity(second);

    const subjects = (await memoryAuth.listIdentities('account-1')).map((it) => it.subject);
    expect(subjects).toEqual(['sub-a', 'sub-z']);
  });

  it('listAccessTokens: 同着の2行のうち先に作ったほうだけ後から更新すると、id 昇順のまま動かない', async () => {
    const memoryAuth = createMemoryStores().auth;
    await memoryAuth.putAccount(account);
    const first = {
      id: 'token-first',
      accountId: 'account-1',
      sha256: 'a'.repeat(64),
      label: 'first',
      createdAt: TIE,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    const second = {
      id: 'token-second',
      accountId: 'account-1',
      sha256: 'b'.repeat(64),
      label: 'second',
      createdAt: TIE,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    await memoryAuth.putAccessToken(first);
    await memoryAuth.putAccessToken(second);
    await memoryAuth.putAccessToken({ ...first, lastUsedAt: '2026-01-06T00:00:00.000Z' });

    const ids = (await memoryAuth.listAccessTokens('account-1')).map((it) => it.id);
    expect(ids).toEqual(['token-first', 'token-second']);
  });

  it('listAccessTokens: 同着2行を2次キー（id）と逆順に挿入しても、id 昇順で返る', async () => {
    const memoryAuth = createMemoryStores().auth;
    await memoryAuth.putAccount(account);
    const first = {
      id: 'token-z',
      accountId: 'account-1',
      sha256: 'a'.repeat(64),
      label: 'z',
      createdAt: TIE,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    const second = {
      id: 'token-a',
      accountId: 'account-1',
      sha256: 'b'.repeat(64),
      label: 'a',
      createdAt: TIE,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    await memoryAuth.putAccessToken(first);
    await memoryAuth.putAccessToken(second);

    const ids = (await memoryAuth.listAccessTokens('account-1')).map((it) => it.id);
    expect(ids).toEqual(['token-a', 'token-z']);
  });
});

describe('isDeclaredOwner（宣言済み owner の判定）', () => {
  const base: AuthAccount = {
    id: 'acc-1',
    displayName: null,
    email: null,
    createdAt: '2026-09-17T00:00:00.000Z',
    lastLoginAt: null,
    grantedAt: null,
    grantedBy: null,
    ownerDeclaredAt: null,
  };

  it('① 宣言済み（かつ許可済み）なら真', () => {
    const account = {
      ...base,
      grantedAt: '2026-09-17T01:00:00.000Z',
      grantedBy: 'operator',
      ownerDeclaredAt: '2026-09-18T00:00:00.000Z',
    };
    expect(isDeclaredOwner(account)).toBe(true);
    expect(isAccountGranted(account)).toBe(true);
  });

  it('② 許可済みでも宣言していなければ偽（広げすぎていないことの対照）', () => {
    const account = { ...base, grantedAt: '2026-09-17T01:00:00.000Z', grantedBy: 'operator' };
    expect(isAccountGranted(account)).toBe(true);
    expect(isDeclaredOwner(account)).toBe(false);
  });

  it('② ログインしただけ（未許可・未宣言）は偽', () => {
    expect(isDeclaredOwner(base)).toBe(false);
  });

  it('③ 許可が落ちていれば、ownerDeclaredAt が入ったままでも偽（不変条件へ寄りかからない）', () => {
    const account = { ...base, grantedAt: null, ownerDeclaredAt: '2026-09-18T00:00:00.000Z' };
    expect(isDeclaredOwner(account)).toBe(false);
  });
});

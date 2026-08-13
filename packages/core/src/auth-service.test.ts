import { beforeEach, describe, expect, it } from 'vitest';

import { decodeState, isAccountGranted, type AuthStore } from './auth.js';
import {
  createAuthProviderRegistry,
  type OAuthProfile,
  type OAuthProvider,
} from './auth-providers.js';
import { createAuthService, type AuthService } from './auth-service.js';
import { createMemoryStores } from './testing.js';

/**
 * ログインとアクセス許可（「誰がこの API を叩いているか」の層）。
 *
 * ここで固定したいのは2つ。**①ログインしただけでは使えないこと**（許可は別に
 * 与える）と、**②メールが一致しても既存アカウントへ相乗りできないこと**
 * （他人のメールを名乗れるプロバイダがあるため）。
 */

/** 実ネットワークを叩かない偽プロバイダ。交換結果を差し替えられる。 */
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

/** トークンの保存だけが落ちる器（一時的な DB/FS エラーを模す）。 */
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
          // 別プロバイダで alice のメールを名乗る攻撃者を模す
          'code-impostor': {
            subject: 'sub-impostor',
            email: 'alice@example.test',
            emailVerified: true,
            displayName: 'Not Alice',
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

    // トークンは発行される（＝ログインは成立している）が、許可はまだ無い。
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

    // **トークンを消さずに**許可だけ取り消す。許可はリクエストごとに見ているので、
    // 消し忘れたトークンが生き残らない。
    await service.revoke(claimed.account.id);
    expect(isAccountGranted((await service.authenticate(claimed.token))!)).toBe(false);
  });

  it('許可できるアカウントは高々1つ（マルチユーザーは非ゴール）', async () => {
    const alice = await service.claim(await login('code-alice'));
    const bob = await service.claim(await login('code-bob'));
    if (alice.status !== 'ready' || bob.status !== 'ready') throw new Error('ログインできていない');

    expect(await service.grant(alice.account.id, 'operator')).toMatchObject({ status: 'granted' });

    // 2人目は通らない。ここを開けると、ログインした人数だけ同じクローンの
    // 記憶・日誌・実行 API が開く＝そのままマルチユーザー利用になる。
    const second = await service.grant(bob.account.id, 'operator');
    expect(second.status).toBe('conflict');
    if (second.status === 'conflict') expect(second.owner.id).toBe(alice.account.id);
    expect(isAccountGranted((await service.authenticate(bob.token))!)).toBe(false);

    // 持ち主を移すときは先に取り消す。
    await service.revoke(alice.account.id);
    expect(await service.grant(bob.account.id, 'operator')).toMatchObject({ status: 'granted' });
    expect(isAccountGranted((await service.authenticate(bob.token))!)).toBe(true);
    expect(isAccountGranted((await service.authenticate(alice.token))!)).toBe(false);
  });

  it('別々のアカウントへ同時に grant しても、持ち主は1人しかできない', async () => {
    const alice = await service.claim(await login('code-alice'));
    const bob = await service.claim(await login('code-bob'));
    if (alice.status !== 'ready' || bob.status !== 'ready') throw new Error('ログインできていない');

    // 一覧を見てから書く形だと、owner が居ない状態の同時実行を両方すり抜ける。
    const results = await Promise.all([
      service.grant(alice.account.id, 'operator'),
      service.grant(bob.account.id, 'operator'),
    ]);

    expect(results.filter((result) => result.status === 'granted')).toHaveLength(1);
    // 応答が1件でも、器に2人残っていたら両方が通ってしまう。
    const granted = (await service.listAccounts()).filter((account) => account.grantedAt !== null);
    expect(granted).toHaveLength(1);
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

    // 器が一時的に落ちる。ここで要求まで消費してしまうと、人間はやり直すしかない
    // のに「やり直しても invalid_request」という袋小路に入る。
    await expect(
      failing.claim({ requestId: started.requestId, claimSecret: started.claimSecret }),
    ).rejects.toThrow();

    // 器が戻れば、同じログインをそのまま回収できる。
    const recovered = await service.claim({
      requestId: started.requestId,
      claimSecret: started.claimSecret,
    });
    expect(recovered.status).toBe('ready');
  });

  it('owner() は許可されている唯一のアカウントを返す', async () => {
    expect(await service.owner()).toBeNull();
    const alice = await service.claim(await login('code-alice'));
    if (alice.status !== 'ready') throw new Error('ログインできていない');

    await service.grant(alice.account.id, 'operator');
    expect((await service.owner())?.id).toBe(alice.account.id);

    await service.revoke(alice.account.id);
    expect(await service.owner()).toBeNull();
  });

  it('検証済みメールが一致しても既存アカウントへ相乗りさせない', async () => {
    const alice = await login('code-alice');
    const claimedAlice = await service.claim(alice);
    if (claimedAlice.status !== 'ready') throw new Error('ログインできていない');
    await service.grant(claimedAlice.account.id, 'operator');

    // 別 identity が同じメールを名乗ってログインしてくる
    const impostor = await login('code-impostor');
    const claimedImpostor = await service.claim(impostor);
    if (claimedImpostor.status !== 'ready') throw new Error('ログインできていない');

    // 別アカウントになり、alice の許可を引き継がない。
    expect(claimedImpostor.account.id).not.toBe(claimedAlice.account.id);
    expect(isAccountGranted(claimedImpostor.account)).toBe(false);
    // 検証済みメールの一意性も壊れない（連絡先は空のまま）。
    expect(claimedImpostor.account.email).toBeNull();
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
    // 端末ごとに別のトークンが出る（1本を使い回さない）。
    expect(claimedSecond.token).not.toBe(claimedFirst.token);
    expect(await service.authenticate(claimedFirst.token)).not.toBeNull();
  });

  it('同じ claim を並行に投げても、有効なトークンは1本しか出ない', async () => {
    const { requestId, claimSecret } = await login('code-alice');

    // 検査とトークン発行を分けていると、ここで全部が `authenticated` を読んで
    // それぞれトークンを受け取れてしまう（「返るのはこの1回だけ」が破れる）。
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.claim({ requestId, claimSecret })),
    );

    const ready = results.filter((result) => result.status === 'ready');
    expect(ready).toHaveLength(1);

    const first = ready[0];
    if (first?.status !== 'ready') throw new Error('ready が無い');
    // 保存された側も1本だけ（応答が1本でも、器に2本残っていたら通ってしまう）。
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
            // 認可コードは一度きり。2回目以降はプロバイダが必ず失敗させる。
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

    // ブラウザの再送・プロキシのリトライで普通に起きる形。
    const results = await Promise.all([
      oneTimeCode.completeLogin({ state, code: 'code-alice' }),
      oneTimeCode.completeLogin({ state, code: 'code-alice' }),
      oneTimeCode.completeLogin({ state, code: 'code-alice' }),
    ]);

    // 交換へ進めるのは1本だけ（進めてしまうと、失敗した側が成功を打ち消す）。
    expect(exchanges).toBe(1);
    expect(results.filter((result) => result.status === 'ok')).toHaveLength(1);

    // 最終状態が authenticated のまま残っていること＝端末が回収できること。
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
    // ブラウザ側が交換に入ったところ
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
});

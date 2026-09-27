import { describe, expect, it } from 'vitest';

import { decodeState, sha256Hex, type AuthStore } from './auth.js';
import {
  createAuthProviderRegistry,
  type OAuthProfile,
  type OAuthProvider,
} from './auth-providers.js';
import { createAuthService } from './auth-service.js';
import { createMemoryStores } from './testing.js';

/**
 * 再現テスト（PR #1770、issue #1757 の横断レビュー）。
 *
 * `AuthService.authenticate` は
 *   1. `store.findAccessTokenBySha256` でトークンの行を読む
 *   2. `store.getAccount` を await する
 *   3. `touch()` → `store.putAccessToken({ ...record, lastUsedAt })` で
 *      「1で読んだときのスナップショット」をまるごと書き戻す（lastUsedAt の
 *      スロットル内なら書かない。60秒に一度）
 *
 * という順で進む。2 の await の最中に、**別のリクエストが同じトークンを
 * `POST /auth/logout`（`AuthService.logout` → `store.revokeAccessToken`、
 * 条件付き UPDATE で書く）で失効させ切ってしまうと**、3 の
 * `putAccessToken` は 1 で読んだ「まだ失効していない」スナップショットを
 * そのまま書き戻す。`putAccessToken` は fs / pg / メモリのどの実装でも
 * 「読んで検査して書く」ではなく単純な丸ごと上書きなので、これで
 * `revokedAt` が `null` に巻き戻る——ログアウトが黙って取り消される。
 *
 * これは #1680 / #1687 / #1694 で許可 DB に見つかった lost update と
 * 同じ形（read → 別操作の書き込み → 古いスナップショットでの書き戻し）が、
 * `revokeAccessToken` 自体ではなく `touch`（lastUsedAt の書き戻し）との
 * 組み合わせでアクセストークンに残っている、というもの。
 * `revokeAccessToken` 単体（fs の排他区間・pg の条件付き UPDATE）は正しい。
 * 割れ目は `touch` が `revokeAccessToken` を経由しない生の `putAccessToken`
 * で、読み込み時点の全体スナップショットを書き戻すところにある。
 */

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

/** `getAccount` だけを、外から渡した gate が解決するまで止める器。 */
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

    // getAccount の途中で止まる authenticate（= まさに `authenticate` の
    // 「読んだ直後、touch で書き戻す前」の状態を模す）。
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

    // authenticate が getAccount で止まっている間に、ログアウトを完了させる。
    const logoutResult = await service.logout(claimed.token);
    expect(logoutResult).toEqual({ status: 'ok' });

    const afterLogout = await store.findAccessTokenBySha256(sha256Hex(claimed.token));
    expect(afterLogout?.revokedAt).not.toBeNull();

    // authenticate を続行させる（内部の touch が古いスナップショットで
    // putAccessToken を呼ぶ）。
    releaseGate();
    await authenticatePromise;

    // ここが本来のはず: ログアウトの失効は touch に巻き戻されず残る。
    const afterTouch = await store.findAccessTokenBySha256(sha256Hex(claimed.token));
    expect(afterTouch?.revokedAt).not.toBeNull();

    // 実害: 失効済みのはずのトークンで、もう一度 authenticate が通ってしまわないか。
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
    // 失効は残り、使った記録も進まない。
    expect(afterRevoke?.revokedAt).toBe('2026-09-03T00:00:00.000Z');
    expect(afterRevoke?.lastUsedAt).toBe('2026-09-02T00:00:00.000Z');

    // 無い id では何も起きない（投げない）。
    await expect(
      store.markAccessTokenUsed('no-such-token', '2026-09-05T00:00:00.000Z'),
    ).resolves.toBeUndefined();
  });
});

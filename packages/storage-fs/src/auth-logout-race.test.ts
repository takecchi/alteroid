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

/**
 * issue #1782 の横断レビュー。fs 実装での再現。
 *
 * インメモリ側の対の歯（同じ形）は
 * `packages/core/src/auth-service-logout-race.test.ts`（issue #1782 に貼った版）
 * にある。ここは fs 実装（`FsAuthStore`）に対して同じ手順を当てる。
 *
 * `FsAuthStore.putAccessToken` と `.revokeAccessToken` はどちらも `#mutate`
 * （`withPathLock` で直列化）を通るので、書き込みどうしの競合は無い。
 * それでも壊れるのは、`touch()` が `putAccessToken` に渡す値そのものが
 * ロックの外（`authenticate` の `findAccessTokenBySha256`）で読んだ
 * 「まだ失効していない」スナップショットだから——ロックの中で読み直すのは
 * ファイルであって、渡された値ではない。`#update` の `mutate` 引数は
 * `(file) => ({ ...file, accessTokens: [...filter, parsed] })` で、`parsed`
 * は呼び出し側が固定した値なので、ロックの中で最新の（失効済みの）行を
 * 見ても、それを検査せずに `parsed` で上書きする。
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

/**
 * `getAccount` だけを、外から渡した gate が解決するまで止める器。
 *
 * `FsAuthStore` はクラスのインスタンスで、メソッドはプロトタイプ側に在る
 * ——オブジェクトスプレッド（`{ ...inner, ... }`）では拾えない（自分の
 * 列挙可能プロパティしか写さない）ので `Proxy` で被せる。
 */
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

    // ここが本来のはず: ログアウトの失効は touch に巻き戻されず残る。
    const afterTouch = await store.findAccessTokenBySha256(sha256Hex(claimed.token));
    expect(afterTouch?.revokedAt).not.toBeNull();

    // 実害: 失効済みのはずのトークンで、もう一度 authenticate が通ってしまわないか。
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
    // 失効は残り、使った記録も進まない。
    expect(afterRevoke?.revokedAt).toBe('2026-09-03T00:00:00.000Z');
    expect(afterRevoke?.lastUsedAt).toBe('2026-09-02T00:00:00.000Z');

    // 無い id では何も起きない（投げない）。
    await expect(
      store.markAccessTokenUsed('no-such-token', '2026-09-05T00:00:00.000Z'),
    ).resolves.toBeUndefined();
  });
});

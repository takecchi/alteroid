import type { AuthStore, OAuthProfile, OAuthProvider } from '@alteroid/core';
import {
  createAuthProviderRegistry,
  createAuthService,
  decodeState,
  sha256Hex,
} from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * issue #1782 の横断レビュー。pg 実装（PGlite）での再現。
 *
 * インメモリ側の対の歯（同じ形）は
 * `packages/core/src/auth-service-logout-race.test.ts`（issue #1782 に貼った版）
 * にある。ここは pg 実装（`PgAuthStore`）に対して同じ手順を当てる。
 *
 * `PgAuthStore.revokeAccessToken` 自体は条件付き UPDATE
 * （`revoked_at is null`）で正しい。割れ目は `touch()` が呼ぶ
 * `putAccessToken` の側——`onConflictDoUpdate` の `set` に
 * `revokedAt: optionalDate(value.revokedAt)` を無条件で含むので、
 * `touch()` が渡す「読んだときの（まだ失効していない）スナップショット」
 * がそのまま UPDATE の `revoked_at = null` になり、`revokeAccessToken` が
 * 条件付きで立てた値を無条件に踏み潰す。
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
 * pg 実装もクラスのインスタンスなので、fs 版と同じ理由で `Proxy` を使う
 * （オブジェクトスプレッドではプロトタイプ側のメソッドを拾えない）。
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

let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedPglite());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

describe('AuthService.authenticate と AuthService.logout の競合（issue #1782、pg 実装）', () => {
  it('同時に来た authenticate の touch は、ログアウトによる失効を巻き戻さない（issue #1782）', async () => {
    const store = stores.auth;
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
    const store = stores.auth;
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

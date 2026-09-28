import { describe, expect, it } from 'vitest';

import { decodeState, type AuthStore } from './auth.js';
import {
  createAuthProviderRegistry,
  type OAuthProfile,
  type OAuthProvider,
} from './auth-providers.js';
import { createAuthService } from './auth-service.js';
import { createMemoryStores } from './testing.js';

/**
 * issue #1915。`AuthService.revoke` は `getAccount` で読んだ行を丸ごと
 * `{ ...account, grantedAt: null, grantedBy: null, ownerDeclaredAt: null }`
 * にして `putAccount` で書き戻していた——issue #1870 / PR #1899 が
 * `completeLogin` の再ログイン分岐から取り除いたのと同じ「読んでから丸ごと
 * 書く」形が、`revoke()` にだけ残っていた。`grant()`（`grantAccess`）や
 * `setOwner()`（`setAccountOwner`）はストアの1操作を経由するのでこの形の
 * lost update を起こさないが、`revoke()` には対応する1操作が無かった。
 *
 * ここで固定したい保証は1つ——**`revoke()` は `grantedAt` / `grantedBy` /
 * `ownerDeclaredAt` の3欄だけを動かし、`getAccount` で読んだ後・書き戻す前に
 * 完了した再ログインの `lastLoginAt` を巻き戻してはいけない。**
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
 * `getAccount` が返った直後に合図を出し（＝ `revoke()` が古いスナップショットを
 * 確実に掴んだ後）、書き戻し（`putAccount` と `revokeAccountAccess` の
 * どちらか——直す前は前者、直した後は後者を `revoke()` が使う）は外から渡した
 * gate が解けるまで止める器。`auth-service-login-preserves-access-state.test.ts`
 * の `delayedAccountWrites` と同じ手法——今回は狙う側が `completeLogin` では
 * なく `revoke()` である。**両方の書き戻し経路を同じ gate で遅らせることで、
 * このテストは直す前・直した後のどちらの実装に対しても同じ意味を持つ**
 * （直す前は `putAccount` だけが遅れ、直した後は `revokeAccountAccess` だけが
 * 遅れる）。
 */
function delayedAccountWrites(inner: AuthStore, onRead: () => void, writeGate: Promise<void>) {
  return {
    ...inner,
    getAccount: async (id: string) => {
      const result = await inner.getAccount(id);
      onRead();
      return result;
    },
    putAccount: async (account: Parameters<AuthStore['putAccount']>[0]) => {
      await writeGate;
      return inner.putAccount(account);
    },
    // `revoke()` を直した後は、この1操作（issue #1915）が書き戻し経路になる。
    // 直す前はこの経路が呼ばれることが無いので、このラッパーの存在自体は
    // 前後どちらの実装にも影響しない——`AuthStore`（直す前の版）にはまだ
    // 無いメンバーなので、対象の型を直接付けず `as AuthStore` で戻す。
    revokeAccountAccess: async (accountId: string) => {
      await writeGate;
      return (
        inner as unknown as { revokeAccountAccess(id: string): Promise<void> }
      ).revokeAccountAccess(accountId);
    },
  } as AuthStore;
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('AuthService.revoke は直前に完了した再ログインの lastLoginAt を巻き戻さない（issue #1915）', () => {
  it('revoke が読んだ直後に再ログインが完了しても、lastLoginAt は巻き戻ってはいけない', async () => {
    const store = createMemoryStores().auth;
    let counter = 0;
    // 時刻を明示的に進める——同じミリ秒に複数回 `now()` を呼ぶと
    // `lastLoginAt` が偶然一致し、下の「実際に進んだこと」の検査が
    // 空虚になるため。
    let ticks = 0;
    const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ticks++));
    const providers = createAuthProviderRegistry([fakeProvider()]);
    const service = createAuthService({ store, providers, now, newId: () => `id-${++counter}` });

    // 1回目のログイン。
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
    const lastLoginBeforeRelogin = beforeRace?.lastLoginAt ?? null;
    expect(lastLoginBeforeRelogin).not.toBeNull();

    // 2回目のログイン要求を先に startLogin だけ済ませておく（同じ identity、
    // 別タブでの再ログインを模す）。
    const second = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const stateSecond = decodeState(
      new URL(second.authorizationUrl).searchParams.get('state') ?? '',
    );

    const write = gate();
    const read = gate();
    // revoke() 側だけを遅らせる。再ログインは racing しない普通の
    // store/service（`service`、素の `store` のまま）を使う。
    const racingStore = delayedAccountWrites(store, () => read.release(), write.promise);
    const racingService = createAuthService({
      store: racingStore,
      providers,
      now,
      newId: () => `id-${++counter}`,
    });

    const revokePromise = racingService.revoke(accountId);

    // revoke が「まだ許可あり」のスナップショットを読み終えるまで待つ。
    await read.promise;

    // その直後に、人間が別タブで再ログインを終える（revoke の書き戻しは
    // まだ gate で止まっている）。
    const reloginResult = await service.completeLogin({
      state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
      code: 'unused',
    });
    expect(reloginResult.status).toBe('ok');
    const afterRelogin = await store.getAccount(accountId);
    const lastLoginAfterRelogin = afterRelogin?.lastLoginAt ?? null;
    // 再ログインで lastLoginAt は実際に進んでいる（さもないと以下の検査が
    // 空虚になる）。
    expect(lastLoginAfterRelogin).not.toBe(lastLoginBeforeRelogin);
    // 許可はまだ生きている（revoke はまだ書き戻していない）。
    expect(afterRelogin?.grantedAt).not.toBeNull();

    // revoke を続行させる。
    write.release();
    const revoked = await revokePromise;
    expect(revoked?.grantedAt).toBeNull();
    expect(revoked?.grantedBy).toBeNull();
    expect(revoked?.ownerDeclaredAt).toBeNull();

    // 保証: revoke の書き戻しで、直前の再ログインの lastLoginAt が
    // 巻き戻ってはいけない。`revoke()` の返り値も、書き戻した後に読み直した
    // 最新の行でなければならない（古いスナップショットのままではいけない）。
    expect(revoked?.lastLoginAt).toBe(lastLoginAfterRelogin);
    const afterRevoke = await store.getAccount(accountId);
    expect(afterRevoke?.lastLoginAt).toBe(lastLoginAfterRelogin);
    expect(afterRevoke?.grantedAt).toBeNull();
  });
});

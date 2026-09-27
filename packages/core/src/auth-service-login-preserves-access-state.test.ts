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
 * issue #1870。`completeLogin` のログイン成功後の書き戻しは、`AuthAccount` の
 * 行を「読んでから丸ごと書く」形をしていた（`account = { ...found, lastLoginAt:
 * at }; await store.putAccount(account);`）——issue #1782 が `touch()`
 * （アクセストークンの `lastUsedAt`）で塞いだのと同じ「読み → 別操作の書き込み
 * → 古いスナップショットでの書き戻し」の形が、対象を `AuthAccount` に変えて
 * 残っていた。`getAccount` で読んだ後・`putAccount` で書く前に `grantAccess`
 * （`alteroid access grant`）や `revoke`（`alteroid access revoke`）が完了すると、
 * ログインの書き戻しがそれを丸ごと巻き戻す。
 *
 * ここで固定したい保証は1つ——**ログイン（初回・再ログインの両方の分岐）は
 * `lastLoginAt`（と、負けた側の分岐では identity のメール追従）以外の欄を
 * 動かしてはいけない。** `grantedAt` / `grantedBy` / `ownerDeclaredAt` は、
 * 直前に完了した別操作の結果をそのまま保つ。
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
 * `getAccount` が返った直後に合図を出し（＝古いスナップショットを
 * `completeLogin` の側が確実に掴んだ後）、`putAccount` は外から渡した
 * gate が解けるまで止める器。読み（合図）と書き（gate）を分けることで、
 * 「読んだ後・書く前」の窓を確定的に再現する（`authenticate` の `touch` を
 * 狙い撃った issue #1782 の再現テストと同じ手法）。
 */
function delayedAccountWrites(
  inner: AuthStore,
  onRead: () => void,
  writeGate: Promise<void>,
): AuthStore {
  return {
    ...inner,
    getAccount: async (id) => {
      const result = await inner.getAccount(id);
      onRead();
      return result;
    },
    putAccount: async (account) => {
      await writeGate;
      return inner.putAccount(account);
    },
  };
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('AuthService.completeLogin はログイン以外の状態を書き戻さない（issue #1870）', () => {
  it('再ログイン（既存 identity）は、その直前に付与された access grant を消してはいけない', async () => {
    const store = createMemoryStores().auth;
    let counter = 0;
    const providers = createAuthProviderRegistry([fakeProvider()]);
    const service = createAuthService({ store, providers, newId: () => `id-${++counter}` });

    // 1回目のログイン。まだ許可は無い。
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
    const racingStore = delayedAccountWrites(store, () => read.release(), write.promise);
    const racingService = createAuthService({
      store: racingStore,
      providers,
      newId: () => `id-${++counter}`,
    });

    const reloginPromise = racingService.completeLogin({
      state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
      code: 'unused',
    });

    // 再ログインが「まだ未許可」のスナップショットを読み終えるまで待つ。
    await read.promise;
    // その直後に、人間が access grant を叩く（再ログインの putAccount は
    // まだ gate で止まっている）。
    const granted = await service.grant(accountId, 'operator');
    expect(granted.status).toBe('granted');
    expect((await store.getAccount(accountId))?.grantedAt).not.toBeNull();

    // 再ログインを続行させる。
    write.release();
    const reloginResult = await reloginPromise;
    expect(reloginResult.status).toBe('ok');

    // 保証: grant した直後の再ログインで、許可が消えてはいけない。
    const afterRelogin = await store.getAccount(accountId);
    expect(afterRelogin?.grantedAt).not.toBeNull();
    expect(afterRelogin?.grantedBy).toBe('operator');
  });

  it('再ログイン（既存 identity）は、その直前に取り消された許可・owner宣言を復活させてはいけない', async () => {
    const store = createMemoryStores().auth;
    let counter = 0;
    const providers = createAuthProviderRegistry([fakeProvider()]);
    const service = createAuthService({ store, providers, newId: () => `id-${++counter}` });

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

    // 先に許可し、実行環境の持ち主として宣言しておく（取り消しの対象を作る）。
    expect((await service.grant(accountId, 'operator')).status).toBe('granted');
    expect((await service.setOwner(accountId, true)).status).toBe('ok');
    const beforeRace = await store.getAccount(accountId);
    expect(beforeRace?.grantedAt).not.toBeNull();
    expect(beforeRace?.ownerDeclaredAt).not.toBeNull();

    const second = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const stateSecond = decodeState(
      new URL(second.authorizationUrl).searchParams.get('state') ?? '',
    );

    const write = gate();
    const read = gate();
    const racingStore = delayedAccountWrites(store, () => read.release(), write.promise);
    const racingService = createAuthService({
      store: racingStore,
      providers,
      newId: () => `id-${++counter}`,
    });

    const reloginPromise = racingService.completeLogin({
      state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
      code: 'unused',
    });

    // 再ログインが「まだ許可・owner宣言あり」のスナップショットを読み終える
    // まで待つ。
    await read.promise;
    // その直後に、人間が access revoke を叩く（許可と owner 宣言の両方が
    // 落ちる——`AuthService.revoke` の doc）。再ログインの putAccount は
    // まだ gate で止まっている。
    const revoked = await service.revoke(accountId);
    expect(revoked?.grantedAt).toBeNull();
    expect(revoked?.ownerDeclaredAt).toBeNull();
    expect((await store.getAccount(accountId))?.grantedAt).toBeNull();

    write.release();
    const reloginResult = await reloginPromise;
    expect(reloginResult.status).toBe('ok');

    // 保証: revoke した直後の再ログインで、許可・owner宣言が復活しては
    // いけない（宣言 ⟹ 許可済み、の不変条件を保ったまま両方とも落ちたまま）。
    const afterRelogin = await store.getAccount(accountId);
    expect(afterRelogin?.grantedAt).toBeNull();
    expect(afterRelogin?.ownerDeclaredAt).toBeNull();
  });

  it('同じ identity への同時ログインで負けた側の書き戻しも、その直前に付与された access grant を消してはいけない（#1714 の負け側分岐）', async () => {
    const store = createMemoryStores().auth;
    let counter = 0;
    const providers = createAuthProviderRegistry([fakeProvider()]);
    const service = createAuthService({ store, providers, newId: () => `id-${++counter}` });

    const winnerStart = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const loserStart = await service.startLogin({
      provider: 'fake',
      redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
    });
    const winnerState = decodeState(
      new URL(winnerStart.authorizationUrl).searchParams.get('state') ?? '',
    );
    const loserState = decodeState(
      new URL(loserStart.authorizationUrl).searchParams.get('state') ?? '',
    );

    const write = gate();
    const read = gate();
    const racingStore = delayedAccountWrites(store, () => read.release(), write.promise);
    const racingService = createAuthService({
      store: racingStore,
      providers,
      newId: () => `id-${++counter}`,
    });

    // 左（winner 役）を先に起こして頭1歩分だけ先行させ、右（loser 役、
    // putAccount を gate で止めた racingService）を後から起こす——同じ
    // (provider, subject) なので、先行した側が `createAccountWithIdentity`
    // を先に叩き、後発は「在れば作らない」判定に負けて #1714 の負け側分岐
    // （`auth-service.ts` の `else` 節）へ入る。
    const winnerPromise = service.completeLogin({
      state: `${winnerState?.requestId}.${winnerState?.nonce}`,
      code: 'unused',
    });
    const loserPromise = racingService.completeLogin({
      state: `${loserState?.requestId}.${loserState?.nonce}`,
      code: 'unused',
    });

    const winnerResult = await winnerPromise;
    expect(winnerResult.status).toBe('ok');
    if (winnerResult.status !== 'ok') throw new Error('ログインできていない');
    const accountId = winnerResult.accountId;

    // 負け側が「まだ未許可」のスナップショットを読み終えるまで待つ
    // （＝ #1714 の負け側分岐に実際に入ったことも、ここで確認する）。
    await read.promise;
    const granted = await service.grant(accountId, 'operator');
    expect(granted.status).toBe('granted');
    expect((await store.getAccount(accountId))?.grantedAt).not.toBeNull();

    write.release();
    const loserResult = await loserPromise;
    expect(loserResult.status).toBe('ok');
    if (loserResult.status !== 'ok') throw new Error('ログインできていない');
    // 負け側も同じ account に合流していること（#1714 の保証）。
    expect(loserResult.accountId).toBe(accountId);

    // 保証: 負け側の書き戻しでも、grant した直後の許可が消えてはいけない。
    const afterRace = await store.getAccount(accountId);
    expect(afterRace?.grantedAt).not.toBeNull();
  });
});

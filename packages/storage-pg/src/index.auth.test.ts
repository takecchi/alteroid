import { createAuthProviderRegistry, createAuthService, decodeState } from '@alteroid/core';
import type { OAuthProfile, OAuthProvider } from '@alteroid/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import {
  createPgStoresFromDb,
  describePgConnectionError,
  migrate,
  type PgStores,
} from './index.js';
import { AUTH_ACCOUNTS_EMAIL_LOWER_INDEX } from './migrate.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

describe('AuthStore', () => {
  const account = {
    id: 'account-1',
    displayName: 'Owner',
    email: 'owner@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-01-01T00:00:00.000Z',
    grantedAt: null,
    grantedBy: null,
    ownerDeclaredAt: null,
  };

  it('アカウントを保存して読み戻せる', async () => {
    await stores.auth.putAccount(account);

    expect(await stores.auth.getAccount('account-1')).toEqual(account);
    expect(await stores.auth.listAccounts()).toEqual([account]);
    expect(await stores.auth.getAccount('居ない')).toBeNull();
  });

  it('listAccounts は createdAt の実時刻順（timestamptz 列で比較するのでオフセット表記が違っても崩れない）', async () => {
    const early = {
      ...account,
      id: 'account-early-utc',
      email: 'early@example.test',
      createdAt: '2024-01-01T23:00:00+09:00',
    };
    const late = {
      ...account,
      id: 'account-late-utc',
      email: 'late@example.test',
      createdAt: '2024-01-01T15:00:00+00:00',
    };
    await stores.auth.putAccount(early);
    await stores.auth.putAccount(late);

    const ids = (await stores.auth.listAccounts()).map((it) => it.id);
    expect(ids).toEqual(['account-early-utc', 'account-late-utc']);
  });

  it('listIdentities は createdAt の実時刻順で返す', async () => {
    await stores.auth.putAccount(account);
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
    await stores.auth.putIdentity(second);
    await stores.auth.putIdentity(first);

    const subjects = (await stores.auth.listIdentities('account-1')).map((it) => it.subject);
    expect(subjects).toEqual(['sub-first', 'sub-second']);
  });

  it('listAccessTokens は createdAt の実時刻順で返す', async () => {
    await stores.auth.putAccount(account);
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
    await stores.auth.putAccessToken(second);
    await stores.auth.putAccessToken(first);

    const ids = (await stores.auth.listAccessTokens('account-1')).map((it) => it.id);
    expect(ids).toEqual(['token-first', 'token-second']);
  });

  describe('同着（createdAt が同一）の並び（issue #1688）', () => {
    const TIE = '2026-01-05T00:00:00.000Z';

    it('listAccounts: 同着の2行のうち先に作ったほうだけ後から更新すると、id 昇順のまま動かない', async () => {
      const first = { ...account, id: 'account-a', email: 'a@example.test', createdAt: TIE };
      const second = { ...account, id: 'account-b', email: 'b@example.test', createdAt: TIE };
      await stores.auth.putAccount(first);
      await stores.auth.putAccount(second);
      await stores.auth.putAccount({ ...first, displayName: 'Owner (renamed)' });

      const ids = (await stores.auth.listAccounts()).map((it) => it.id);
      expect(ids).toEqual(['account-a', 'account-b']);
    });

    it('listAccounts: 同着2行を2次キー（id）と逆順に挿入しても、id 昇順で返る', async () => {
      const first = { ...account, id: 'account-z', email: 'z@example.test', createdAt: TIE };
      const second = { ...account, id: 'account-a', email: 'a@example.test', createdAt: TIE };
      await stores.auth.putAccount(first);
      await stores.auth.putAccount(second);

      const ids = (await stores.auth.listAccounts()).map((it) => it.id);
      expect(ids).toEqual(['account-a', 'account-z']);
    });

    it('listIdentities: 同着の2行のうち先に作ったほうだけ後から更新すると、(provider, subject) 昇順のまま動かない', async () => {
      await stores.auth.putAccount(account);
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
      await stores.auth.putIdentity(first);
      await stores.auth.putIdentity(second);
      await stores.auth.putIdentity({ ...first, lastLoginAt: '2026-01-06T00:00:00.000Z' });

      const subjects = (await stores.auth.listIdentities('account-1')).map((it) => it.subject);
      expect(subjects).toEqual(['sub-first', 'sub-second']);
    });

    it('listIdentities: 同着2行を2次キー（subject）と逆順に挿入しても、subject 昇順で返る', async () => {
      await stores.auth.putAccount(account);
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
      await stores.auth.putIdentity(first);
      await stores.auth.putIdentity(second);

      const subjects = (await stores.auth.listIdentities('account-1')).map((it) => it.subject);
      expect(subjects).toEqual(['sub-a', 'sub-z']);
    });

    it('listAccessTokens: 同着の2行のうち先に作ったほうだけ後から更新すると、id 昇順のまま動かない', async () => {
      await stores.auth.putAccount(account);
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
      await stores.auth.putAccessToken(first);
      await stores.auth.putAccessToken(second);
      await stores.auth.putAccessToken({ ...first, lastUsedAt: '2026-01-06T00:00:00.000Z' });

      const ids = (await stores.auth.listAccessTokens('account-1')).map((it) => it.id);
      expect(ids).toEqual(['token-first', 'token-second']);
    });

    it('listAccessTokens: 同着2行を2次キー（id）と逆順に挿入しても、id 昇順で返る', async () => {
      await stores.auth.putAccount(account);
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
      await stores.auth.putAccessToken(first);
      await stores.auth.putAccessToken(second);

      const ids = (await stores.auth.listAccessTokens('account-1')).map((it) => it.id);
      expect(ids).toEqual(['token-a', 'token-z']);
    });
  });

  it('許可の2値を書き換えられる（alteroid access grant の実体）', async () => {
    await stores.auth.putAccount(account);
    await stores.auth.putAccount({
      ...account,
      grantedAt: '2026-01-02T00:00:00.000Z',
      grantedBy: 'operator',
    });

    const stored = await stores.auth.getAccount('account-1');
    expect(stored?.grantedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(stored?.grantedBy).toBe('operator');
    expect(await stores.auth.listAccounts()).toHaveLength(1);
  });

  it('検証済みメールからアカウントを引ける（相乗りの検査に使う）', async () => {
    await stores.auth.putAccount(account);

    expect((await stores.auth.findAccountByEmail('owner@example.test'))?.id).toBe('account-1');
    expect(await stores.auth.findAccountByEmail('別人@example.test')).toBeNull();
  });

  it('identity は (provider, subject) で一意（同じ人の入り直しで増えない）', async () => {
    await stores.auth.putAccount(account);
    const identity = {
      provider: 'google',
      subject: 'sub-1',
      accountId: 'account-1',
      email: 'owner@example.test',
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-01-01T00:00:00.000Z',
    };
    await stores.auth.putIdentity(identity);
    await stores.auth.putIdentity({ ...identity, lastLoginAt: '2026-01-05T00:00:00.000Z' });

    const identities = await stores.auth.listIdentities('account-1');
    expect(identities).toHaveLength(1);
    expect(identities[0]?.lastLoginAt).toBe('2026-01-05T00:00:00.000Z');
    expect((await stores.auth.findIdentity('google', 'sub-1'))?.accountId).toBe('account-1');
    expect(await stores.auth.findIdentity('google', '別の sub')).toBeNull();
  });

  it('アクセストークンは sha256 で引ける（素の値は持たない）', async () => {
    await stores.auth.putAccount(account);
    const token = {
      id: 'token-1',
      accountId: 'account-1',
      sha256: 'a'.repeat(64),
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-02-01T00:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
    };
    await stores.auth.putAccessToken(token);

    expect(await stores.auth.findAccessTokenBySha256('a'.repeat(64))).toEqual(token);
    expect(await stores.auth.findAccessTokenBySha256('b'.repeat(64))).toBeNull();
    expect(await stores.auth.listAccessTokens('account-1')).toEqual([token]);
  });

  describe('revokeAccessToken', () => {
    const token = {
      id: 'token-1',
      accountId: 'account-1',
      sha256: 'a'.repeat(64),
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };

    it('失効させる（revokedAt が立ち、他のトークンは影響を受けない）', async () => {
      await stores.auth.putAccount(account);
      await stores.auth.putAccessToken(token);
      const other = { ...token, id: 'token-2', sha256: 'b'.repeat(64) };
      await stores.auth.putAccessToken(other);

      const result = await stores.auth.revokeAccessToken('token-1', '2026-01-02T00:00:00.000Z');
      expect(result).toEqual({
        status: 'revoked',
        token: { ...token, revokedAt: '2026-01-02T00:00:00.000Z' },
      });
      expect((await stores.auth.findAccessTokenBySha256('a'.repeat(64)))?.revokedAt).toBe(
        '2026-01-02T00:00:00.000Z',
      );
      expect((await stores.auth.findAccessTokenBySha256('b'.repeat(64)))?.revokedAt).toBeNull();
    });

    it('もう一度呼んでも、先に立った時刻を動かさない（冪等）', async () => {
      await stores.auth.putAccount(account);
      await stores.auth.putAccessToken(token);

      await stores.auth.revokeAccessToken('token-1', '2026-01-02T00:00:00.000Z');
      const second = await stores.auth.revokeAccessToken('token-1', '2026-01-03T00:00:00.000Z');

      expect(second).toEqual({
        status: 'already_revoked',
        token: { ...token, revokedAt: '2026-01-02T00:00:00.000Z' },
      });
      expect((await stores.auth.findAccessTokenBySha256('a'.repeat(64)))?.revokedAt).toBe(
        '2026-01-02T00:00:00.000Z',
      );
    });

    it('無い id は not_found', async () => {
      expect(await stores.auth.revokeAccessToken('居ない', '2026-01-02T00:00:00.000Z')).toEqual({
        status: 'not_found',
      });
    });
  });

  it('ログイン要求を保存して読み戻せる（ブラウザ往復の突き合わせ）', async () => {
    const request = {
      id: 'login-1',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'c'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending' as const,
      accountId: null,
      error: null,
    };
    await stores.auth.putLoginRequest(request);
    expect(await stores.auth.getLoginRequest('login-1')).toEqual(request);

    await stores.auth.putLoginRequest({ ...request, status: 'consumed' as const });
    expect((await stores.auth.getLoginRequest('login-1'))?.status).toBe('consumed');
    expect(await stores.auth.getLoginRequest('居ない')).toBeNull();
  });
  it('ログイン要求の引き取りは1回だけ成功する（並行でも二重発行させない）', async () => {
    const request = {
      id: 'login-2',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'd'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'authenticated' as const,
      accountId: 'account-1',
      error: null,
    };
    await stores.auth.putAccount(account);
    await stores.auth.putLoginRequest(request);

    let issued = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        stores.auth.claimLoginRequest('login-2', (request) => ({
          id: `token-race-${++issued}`,
          accountId: request.accountId ?? '',
          sha256: String(issued).repeat(64).slice(0, 64),
          label: request.label,
          createdAt: '2026-01-02T00:00:00.000Z',
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
        })),
      ),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await stores.auth.getLoginRequest('login-2'))?.status).toBe('consumed');
    expect(await stores.auth.listAccessTokens('account-1')).toHaveLength(1);
    expect(await stores.auth.claimLoginRequest('login-2', () => neverIssued())).toBeNull();
  });

  it('pending のログイン要求は引き取れない（ブラウザ側が終わる前に発行しない）', async () => {
    await stores.auth.putLoginRequest({
      id: 'login-3',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'e'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending',
      accountId: null,
      error: null,
    });

    expect(await stores.auth.claimLoginRequest('login-3', () => neverIssued())).toBeNull();
    expect((await stores.auth.getLoginRequest('login-3'))?.status).toBe('pending');
    expect(await stores.auth.claimLoginRequest('居ない', () => neverIssued())).toBeNull();
  });
  it('別々のアカウントへ同時に grant すると、両方通る（上限が無い）', async () => {
    const other = { ...account, id: 'account-2', email: 'other@example.test' };
    await stores.auth.putAccount(account);
    await stores.auth.putAccount(other);

    const at = '2026-01-02T00:00:00.000Z';
    const results = await Promise.all([
      stores.auth.grantAccess('account-1', at, 'operator'),
      stores.auth.grantAccess('account-2', at, 'operator'),
    ]);

    expect(results.filter((result) => result.status === 'granted')).toHaveLength(2);
    const granted = (await stores.auth.listAccounts()).filter((it) => it.grantedAt !== null);
    expect(granted).toHaveLength(2);
  });

  it('同じアカウントへ同時に grant しても、grantedBy は先に書いた側のまま', async () => {
    await stores.auth.putAccount(account);

    const at = '2026-01-02T00:00:00.000Z';
    const results = await Promise.all([
      stores.auth.grantAccess('account-1', at, 'operator'),
      stores.auth.grantAccess('account-1', at, 'account-9'),
    ]);

    expect(results.every((result) => result.status === 'granted')).toBe(true);
    const stored = (await stores.auth.listAccounts()).find((it) => it.id === 'account-1');
    expect(
      results.map((result) => (result.status === 'granted' ? result.account.grantedBy : null)),
    ).toEqual([stored?.grantedBy, stored?.grantedBy]);
  });

  it('createAccountWithIdentity を同じ identity で並行に呼んでも、1つだけ作られる（負けた側の account は孤児にならない）', async () => {
    const makeInput = (accountId: string) => ({
      account: {
        id: accountId,
        displayName: 'Someone',
        email: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
        grantedAt: null,
        grantedBy: null,
        ownerDeclaredAt: null,
      },
      identity: {
        provider: 'google',
        subject: 'sub-race',
        accountId,
        email: 'race@example.test',
        emailVerified: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const results = await Promise.all([
      stores.auth.createAccountWithIdentity(makeInput('account-race-a')),
      stores.auth.createAccountWithIdentity(makeInput('account-race-b')),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    const loser = results.find((result) => !result.created);
    expect(loser).toBeDefined();
    if (loser !== undefined && !loser.created) {
      expect(loser.existing.subject).toBe('sub-race');
    }

    const identities = await stores.auth.listIdentities('account-race-a');
    const identitiesB = await stores.auth.listIdentities('account-race-b');
    expect(identities.length + identitiesB.length).toBe(1);

    const accounts = (await stores.auth.listAccounts()).filter((it) =>
      it.id.startsWith('account-race-'),
    );
    expect(accounts).toHaveLength(1);
  });

  it('createAccountWithIdentity: 2つの候補が同じ検証済みメールを持っていても、投げずに1つだけ作られる', async () => {
    const makeInput = (accountId: string) => ({
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
        subject: 'sub-email-race',
        accountId,
        email: 'shared@example.test',
        emailVerified: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const results = await Promise.all([
      stores.auth.createAccountWithIdentity(makeInput('account-email-race-a')),
      stores.auth.createAccountWithIdentity(makeInput('account-email-race-b')),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    const loser = results.find((result) => !result.created);
    expect(loser).toBeDefined();
    if (loser !== undefined && !loser.created) {
      expect(loser.existing.subject).toBe('sub-email-race');
    }

    const accounts = (await stores.auth.listAccounts()).filter((it) =>
      it.id.startsWith('account-email-race-'),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.email).toBe('shared@example.test');
  });

  // 「migrate を2回通す」だけにしない: 許可済みの行が1つだと古い索引でも一意で、2周目の create が通ってしまうため。2人目を挟む。
  it('許可を2つ積んでから起動し直しても migrate が落ちない（古い索引を作りに戻らない）', async () => {
    await db.execute(
      sql.raw(
        `create unique index if not exists auth_accounts_single_owner_idx
           on auth_accounts ((granted_at is not null)) where granted_at is not null`,
      ),
    );

    await migrate(db);

    const other = { ...account, id: 'account-2', email: 'other@example.test' };
    await stores.auth.putAccount(account);
    await stores.auth.putAccount(other);
    const at = '2026-01-02T00:00:00.000Z';
    await stores.auth.grantAccess('account-1', at, 'operator');
    await stores.auth.grantAccess('account-2', at, 'operator');

    await expect(migrate(db)).resolves.toBeUndefined();
    await expect(migrate(db)).resolves.toBeUndefined();

    const granted = (await stores.auth.listAccounts()).filter((it) => it.grantedAt !== null);
    expect(granted).toHaveLength(2);
  });

  it('トークンの保存が落ちたら、ログイン要求は authenticated のまま残る', async () => {
    await stores.auth.putAccount(account);
    await stores.auth.putLoginRequest({
      id: 'login-4',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'f'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'authenticated',
      accountId: 'account-1',
      error: null,
    });

    await expect(
      stores.auth.claimLoginRequest('login-4', () => {
        throw new Error('トークンを作れなかった');
      }),
    ).rejects.toThrow();
    expect((await stores.auth.getLoginRequest('login-4'))?.status).toBe('authenticated');

    const claimed = await stores.auth.claimLoginRequest('login-4', (request) => ({
      id: 'token-4',
      accountId: request.accountId ?? '',
      sha256: 'b'.repeat(64),
      label: request.label,
      createdAt: '2026-01-02T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    }));
    expect(claimed?.token.id).toBe('token-4');
    expect((await stores.auth.getLoginRequest('login-4'))?.status).toBe('consumed');
    expect(await stores.auth.listAccessTokens('account-1')).toHaveLength(1);
  });
  it('交換へ進む権利は1つのリクエストしか取れない', async () => {
    await stores.auth.putLoginRequest({
      id: 'login-5',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'a'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending',
      accountId: null,
      error: null,
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => stores.auth.beginLoginExchange('login-5')),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await stores.auth.getLoginRequest('login-5'))?.status).toBe('processing');
    expect(await stores.auth.beginLoginExchange('login-5')).toBeNull();
    expect(await stores.auth.beginLoginExchange('居ない')).toBeNull();
  });

  describe('setAccountOwner（実行環境の持ち主としての宣言）', () => {
    it('許可済みの行には宣言を立てられる', async () => {
      await stores.auth.putAccount({
        ...account,
        grantedAt: '2026-01-02T00:00:00.000Z',
        grantedBy: 'operator',
      });

      const result = await stores.auth.setAccountOwner('account-1', '2026-01-03T00:00:00.000Z');
      expect(result).toEqual({
        status: 'ok',
        account: {
          ...account,
          grantedAt: '2026-01-02T00:00:00.000Z',
          grantedBy: 'operator',
          ownerDeclaredAt: '2026-01-03T00:00:00.000Z',
        },
      });
      expect((await stores.auth.getAccount('account-1'))?.ownerDeclaredAt).toBe(
        '2026-01-03T00:00:00.000Z',
      );
    });

    it('未許可の行へ宣言しようとすると not_granted（不変条件「宣言 ⟹ 許可済み」）', async () => {
      await stores.auth.putAccount(account);

      const result = await stores.auth.setAccountOwner('account-1', '2026-01-03T00:00:00.000Z');
      expect(result).toEqual({ status: 'not_granted' });
      expect((await stores.auth.getAccount('account-1'))?.ownerDeclaredAt).toBeNull();
    });

    it('存在しないアカウントへの宣言は not_found', async () => {
      expect(await stores.auth.setAccountOwner('居ない', '2026-01-03T00:00:00.000Z')).toEqual({
        status: 'not_found',
      });
    });

    it('取り消し（null）は許可の有無を問わず常に通る', async () => {
      await stores.auth.putAccount(account);

      const result = await stores.auth.setAccountOwner('account-1', null);
      expect(result).toEqual({ status: 'ok', account });
    });

    it('存在しないアカウントの取り消しは not_found', async () => {
      expect(await stores.auth.setAccountOwner('居ない', null)).toEqual({ status: 'not_found' });
    });
  });

  describe('大小文字だけが違う検証済みメール（#1702）', () => {
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

    it('大小文字だけが違う検証済みメールも衝突として検出し、2つ目のアカウントには乗せない', async () => {
      const service = createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry([
          fakeProvider({
            'code-alice': {
              subject: 'sub-alice',
              email: 'alice@example.test',
              emailVerified: true,
              displayName: 'Alice',
            },
            'code-impostor-case': {
              subject: 'sub-impostor-case',
              email: 'ALICE@EXAMPLE.TEST',
              emailVerified: true,
              displayName: 'Not Alice (case)',
            },
          }),
        ]),
      });

      async function login(code: string): Promise<{ requestId: string; claimSecret: string }> {
        const started = await service.startLogin({
          provider: 'fake',
          redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
        });
        const state = decodeState(
          new URL(started.authorizationUrl).searchParams.get('state') ?? '',
        );
        expect(state).not.toBeNull();
        const completed = await service.completeLogin({
          state: `${state?.requestId}.${state?.nonce}`,
          code,
        });
        expect(completed.status).toBe('ok');
        return { requestId: started.requestId, claimSecret: started.claimSecret };
      }

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

    // `allSettled` にしない: reject が起きても検出できないため、`Promise.all` で確かめる。
    it('r2: 別々の identity が大小文字だけ違う検証済みメールで同時にログインしても、投げずに検証済みメールを持つアカウントは1つだけ', async () => {
      const service = createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry([
          fakeProvider({
            'code-alice': {
              subject: 'sub-alice',
              email: 'alice@example.test',
              emailVerified: true,
              displayName: 'Alice',
            },
            'code-impostor-case': {
              subject: 'sub-impostor-case',
              email: 'ALICE@EXAMPLE.TEST',
              emailVerified: true,
              displayName: 'Not Alice (case)',
            },
          }),
        ]),
      });

      const first = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const second = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const stateFirst = decodeState(
        new URL(first.authorizationUrl).searchParams.get('state') ?? '',
      );
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

      const accounts = await stores.auth.listAccounts();
      expect(accounts).toHaveLength(2);
      const withVerifiedEmail = accounts.filter((account) => account.email !== null);
      expect(withVerifiedEmail).toHaveLength(1);
    });

    it('#1741: 別々の identity が大小文字まで同じ検証済みメールで同時にログインしても、投げずに検証済みメールを持つアカウントは1つだけ', async () => {
      const service = createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry([
          fakeProvider({
            'code-alice': {
              subject: 'sub-alice',
              email: 'alice@example.test',
              emailVerified: true,
              displayName: 'Alice',
            },
            'code-impostor-samecase': {
              subject: 'sub-impostor-samecase',
              email: 'alice@example.test',
              emailVerified: true,
              displayName: 'Not Alice (same case)',
            },
          }),
        ]),
      });

      const first = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const second = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const stateFirst = decodeState(
        new URL(first.authorizationUrl).searchParams.get('state') ?? '',
      );
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

      const accounts = await stores.auth.listAccounts();
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
        stores.auth.createAccountWithIdentity(makeInput('account-diff-identity-a', 'sub-diff-a')),
        stores.auth.createAccountWithIdentity(makeInput('account-diff-identity-b', 'sub-diff-b')),
      ]);

      expect(results.every((result) => result.created)).toBe(true);
      const emails = results.map((result) => (result.created ? result.account.email : null));
      expect(emails.filter((email) => email !== null)).toHaveLength(1);

      const accounts = (await stores.auth.listAccounts()).filter((it) =>
        it.id.startsWith('account-diff-identity-'),
      );
      expect(accounts).toHaveLength(2);
      expect(accounts.filter((it) => it.email !== null)).toHaveLength(1);
    });

    // 重複の有無を assert しない: 事前 select と insert の間の競合 window は塞がっておらず、保証できるのは「投げないこと」だけのため。
    it('#1702 の重複状態（旧索引だけの DB）でも、別々の identity・大小文字違いの候補メールで並行に呼んでも投げない', async () => {
      // `createEmptyTestDb()` ＋ `migrate` を使わない: テスト本体で PGlite をもう1つ起こすと、並列で混んだとき vitest 既定の 5 秒の上限を食い潰すため。
      const localDb = db;
      await localDb.execute(sql.raw(`drop index if exists ${AUTH_ACCOUNTS_EMAIL_LOWER_INDEX}`));
      await localDb.execute(
        sql.raw(
          'create unique index if not exists auth_accounts_email_idx on auth_accounts (email)',
        ),
      );
      const localStores = createPgStoresFromDb(localDb);

      const makeInput = (accountId: string, subject: string, email: string) => ({
        account: {
          id: accountId,
          displayName: 'Someone',
          email,
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
          email,
          emailVerified: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: '2026-01-01T00:00:00.000Z',
        },
      });

      await expect(
        Promise.all([
          localStores.auth.createAccountWithIdentity(
            makeInput('account-old-format-a', 'sub-old-format-a', 'alice@example.test'),
          ),
          localStores.auth.createAccountWithIdentity(
            makeInput('account-old-format-b', 'sub-old-format-b', 'ALICE@EXAMPLE.TEST'),
          ),
        ]),
      ).resolves.toBeDefined();
    });
  });

  describe('同じ identity の同時ログイン（pg。issue #1714 のレビュー修正）', () => {
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

    it('同じ identity で2つのログインが同時に完了しても、アカウントは1つで両方が同じ accountId になる', async () => {
      const service = createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry([
          fakeProvider({
            'code-alice': {
              subject: 'sub-alice-pg-race',
              email: 'alice-pg-race@example.test',
              emailVerified: true,
              displayName: 'Alice',
            },
          }),
        ]),
      });

      const first = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const second = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const stateFirst = decodeState(
        new URL(first.authorizationUrl).searchParams.get('state') ?? '',
      );
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

      const accounts = await stores.auth.listAccounts();
      expect(accounts.filter((it) => it.email === 'alice-pg-race@example.test')).toHaveLength(1);
    });
  });
});

function neverIssued(): never {
  throw new Error('引き取れないはずの要求でトークンを作ろうとした');
}

// `createPgStores` を直接呼ばない: 本物の `Pool` に実際の PostgreSQL が要るため、整形部分の `describePgConnectionError` を呼ぶ。
describe('describePgConnectionError', () => {
  it('SQLSTATE 等の構造化フィールドが出る。detail の値は出ない', () => {
    const pgError = new Error('duplicate key value violates unique constraint "journal_pkey"');
    Object.assign(pgError, {
      code: '23505',
      constraint: 'journal_pkey',
      table: 'journal',
      detail: 'Key (id)=(11111111-2222-3333-4444-555555555555) already exists.',
    });

    const line = describePgConnectionError(pgError);

    expect(line).toContain('alteroid: PostgreSQL の接続でエラー:');
    expect(line).toContain('code=23505');
    expect(line).toContain('constraint=journal_pkey');
    expect(line).toContain('table=journal');
    expect(line).not.toContain('11111111-2222-3333-4444-555555555555');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('SQLSTATE を持たない素の Error でも落ちない（メッセージだけ出る）', () => {
    const line = describePgConnectionError(new Error('ECONNRESET'));

    expect(line).toContain('ECONNRESET');
  });
});

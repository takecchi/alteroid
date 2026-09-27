import type { AccessTokenRecord, AuthAccount, AuthIdentity, LoginRequest } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * issue #1715。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/auth-write-validation.test.ts` の冒頭コメントを見よ。
 *
 * ここは pg 実装（PGlite）に対して同じ入力を当てる——各書き込みが対応する zod
 * スキーマを通すので、この歯は緑になる（直す前から緑）。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
  stores = createPgStoresFromDb(db);
});

describe('AuthStore の書き込み — 形式不正な入力の扱い（pg 実装）', () => {
  const account: AuthAccount = {
    id: 'account-1',
    displayName: 'Owner',
    email: 'owner@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-01-01T00:00:00.000Z',
    grantedAt: null,
    grantedBy: null,
    ownerDeclaredAt: null,
  };

  it('putAccount() は空文字の id を拒む（throw する）', async () => {
    const invalidAccount: AuthAccount = { ...account, id: '' };
    await expect(stores.auth.putAccount(invalidAccount)).rejects.toThrow();
  });

  it('putIdentity() は空文字の subject を拒む（throw する）', async () => {
    await stores.auth.putAccount(account);
    const invalidIdentity: AuthIdentity = {
      provider: 'google',
      subject: '',
      accountId: account.id,
      email: 'owner@example.test',
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-01-01T00:00:00.000Z',
    };
    await expect(stores.auth.putIdentity(invalidIdentity)).rejects.toThrow();
  });

  it('createAccountWithIdentity() は空文字の id の account を拒む（throw する）', async () => {
    const invalidAccount: AuthAccount = { ...account, id: '' };
    await expect(
      stores.auth.createAccountWithIdentity({
        account: invalidAccount,
        identity: {
          provider: 'google',
          subject: 'sub-invalid-account',
          accountId: invalidAccount.id,
          email: 'owner@example.test',
          emailVerified: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    ).rejects.toThrow();
  });

  it('putAccessToken() は長さ64でない sha256 を拒む（throw する）', async () => {
    await stores.auth.putAccount(account);
    const invalidToken: AccessTokenRecord = {
      id: 'token-1',
      accountId: account.id,
      sha256: 'too-short',
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    await expect(stores.auth.putAccessToken(invalidToken)).rejects.toThrow();
  });

  it('putLoginRequest() は空文字の nonce を拒む（throw する）', async () => {
    const invalidRequest: LoginRequest = {
      id: 'login-1',
      provider: 'google',
      nonce: '',
      codeVerifier: 'verifier',
      claimSha256: 'a'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending',
      accountId: null,
      error: null,
    };
    await expect(stores.auth.putLoginRequest(invalidRequest)).rejects.toThrow();
  });

  it('grantAccess() は isoDateTime でない at を拒む（throw する）', async () => {
    await stores.auth.putAccount(account);
    await expect(stores.auth.grantAccess(account.id, '不正な日時', 'operator')).rejects.toThrow();
  });

  it('setAccountOwner() は isoDateTime でない declaredAt を拒む（throw する）', async () => {
    await stores.auth.putAccount(account);
    await stores.auth.grantAccess(account.id, '2026-01-02T00:00:00.000Z', 'operator');
    await expect(stores.auth.setAccountOwner(account.id, '不正な日時')).rejects.toThrow();
  });

  it('claimLoginRequest() は issue() が返した長さ64でない sha256 を拒む（throw する）', async () => {
    await stores.auth.putAccount(account);
    const request: LoginRequest = {
      id: 'login-2',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'b'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'authenticated',
      accountId: account.id,
      error: null,
    };
    await stores.auth.putLoginRequest(request);

    await expect(
      stores.auth.claimLoginRequest('login-2', (consumed) => ({
        id: 'token-race',
        accountId: consumed.accountId ?? '',
        sha256: 'too-short',
        label: consumed.label,
        createdAt: '2026-01-02T00:00:00.000Z',
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      })),
    ).rejects.toThrow();
  });
});

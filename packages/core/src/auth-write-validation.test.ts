import { describe, expect, it } from 'vitest';

import type { AccessTokenRecord, AuthAccount, AuthIdentity, LoginRequest } from './auth.js';
import { createMemoryStores } from './testing.js';

/**
 * `AuthStore` の書き込みの3実装の食い違い（issue #1715、#1652 の続き）。
 *
 * #1652 は `ScheduleStore` / `TokenPoolStore` / `CommitmentStore` / `InboxStore`
 * を扱い、`AuthStore` / `CredentialVaultStore` / `JobStore` を「範囲外（見て
 * いない）」としていた。ここは残っていた `AuthStore` を扱う——fs の各書き込みは
 * 対応する zod スキーマを通してから書く（`packages/storage-fs/src/auth.ts`。
 * 逐語は `grep -Fn -- 'const parsed = authAccountSchema.parse(account);'
 * packages/storage-fs/src/auth.ts`）が、**インメモリ実装はどれも検査を持たず**、
 * `Map.set` へ素通しで渡すだけだった。
 *
 * fs が parse している箇所と1対1で突き合わせた歯——`createMemoryStores()` の
 * `auth.*` が対応するスキーマを通すようになったので緑になる
 * （`packages/storage-fs/src/auth-write-validation.test.ts` /
 * `packages/storage-pg/src/auth-write-validation.test.ts` と同じ形）。
 */
describe('AuthStore の書き込み — 形式不正な入力の扱い（インメモリ実装）', () => {
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

  it('putAccount() は fs / pg と同じく、空文字の id を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    const invalidAccount: AuthAccount = { ...account, id: '' };
    await expect(stores.auth.putAccount(invalidAccount)).rejects.toThrow();
  });

  it('putIdentity() は fs / pg と同じく、空文字の subject を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await stores.auth.putAccount(account);
    const invalidIdentity: AuthIdentity = {
      provider: 'google',
      subject: '', // authIdentitySchema は subject を min(1) で要求する
      accountId: account.id,
      email: 'owner@example.test',
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-01-01T00:00:00.000Z',
    };
    await expect(stores.auth.putIdentity(invalidIdentity)).rejects.toThrow();
  });

  it('createAccountWithIdentity() は fs / pg と同じく、空文字の id の account を拒む（throw する）', async () => {
    const stores = createMemoryStores();
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

  it('putAccessToken() は fs / pg と同じく、長さ64でない sha256 を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await stores.auth.putAccount(account);
    const invalidToken: AccessTokenRecord = {
      id: 'token-1',
      accountId: account.id,
      sha256: 'too-short', // accessTokenRecordSchema は length(64) を要求する
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    await expect(stores.auth.putAccessToken(invalidToken)).rejects.toThrow();
  });

  it('putLoginRequest() は fs / pg と同じく、空文字の nonce を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    const invalidRequest: LoginRequest = {
      id: 'login-1',
      provider: 'google',
      nonce: '', // loginRequestSchema は nonce を min(1) で要求する
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

  it('grantAccess() は fs / pg と同じく、isoDateTime でない at を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await stores.auth.putAccount(account);
    await expect(stores.auth.grantAccess(account.id, '不正な日時', 'operator')).rejects.toThrow();
  });

  it('setAccountOwner() は fs / pg と同じく、isoDateTime でない declaredAt を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await stores.auth.putAccount(account);
    await stores.auth.grantAccess(account.id, '2026-01-02T00:00:00.000Z', 'operator');
    await expect(stores.auth.setAccountOwner(account.id, '不正な日時')).rejects.toThrow();
  });

  it('claimLoginRequest() は fs / pg と同じく、issue() が返した長さ64でない sha256 を拒む（throw する）', async () => {
    const stores = createMemoryStores();
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
        sha256: 'too-short', // accessTokenRecordSchema は length(64) を要求する
        label: consumed.label,
        createdAt: '2026-01-02T00:00:00.000Z',
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      })),
    ).rejects.toThrow();
  });
});

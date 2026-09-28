import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import type { AccessTokenRecord, AuthAccount, AuthIdentity, LoginRequest } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1942（#1868 / PR #1884、#1928 / PR #1930 と同じ形の穴）。
 *
 * `FsAuthStore#read()` の `fileSchema` は `accounts` / `identities` /
 * `accessTokens` / `loginRequests` の4配列すべてを `z.array(<rowSchema>)` で
 * 1回に検査していた。そのため、**どれか1つの配列に1行でも schema に合わない
 * 行があると `ZodError` が投げられ、ログイン・アクセストークンの照会・
 * `access grant` / `revoke` まで、同じ `auth.json` を読む操作がすべて落ちる**
 * ——`#read()` が4配列を同時に返す1つの関数だからである。
 *
 * ここでは pg 版（accounts / identities / accessTokens は正規化された列を
 * 持つので、そもそも「1行の不正が他の行を道連れにする」形をしていない。
 * loginRequests だけ JSONB で持つが、そちらは元から行ごとに `safeParse` して
 * いる）・fs の jobs/approvals（#1868 / #1928）・fs の credentials（#1740）と
 * 同じ「その行だけを飛ばし、残りは返す。書き戻しでは元の形のまま保つ」に
 * auth.json の4配列もそろえる。
 */
describe('FsAuthStore — auth.json の不正な1行を読み飛ばす（issue #1942）', () => {
  let root: string;
  let authPath: string;

  const GOOD_ACCOUNT: AuthAccount = {
    id: 'acct-good',
    displayName: 'Good Owner',
    email: 'good@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    grantedAt: '2026-01-01T00:00:00.000Z',
    grantedBy: 'operator',
    ownerDeclaredAt: null,
  };

  // displayName（必須欄。null は許すが欄自体が無いのは許さない）が欠けている
  // ——版ずれ・手編集を模す。
  const BAD_ACCOUNT_RAW = {
    id: 'acct-bad',
    email: 'bad-account@example.test',
    createdAt: '2026-01-02T00:00:00.000Z',
    lastLoginAt: null,
    grantedAt: null,
    grantedBy: null,
    ownerDeclaredAt: null,
  };

  const GOOD_IDENTITY: AuthIdentity = {
    provider: 'google',
    subject: 'sub-good',
    accountId: GOOD_ACCOUNT.id,
    email: 'good@example.test',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-01-01T00:00:00.000Z',
  };

  // subject（必須欄。空文字も schema が拒む）が欠けている。
  const BAD_IDENTITY_RAW = {
    provider: 'google',
    accountId: 'acct-orphan',
    email: 'bad-identity@example.test',
    emailVerified: true,
    createdAt: '2026-01-02T00:00:00.000Z',
    lastLoginAt: '2026-01-02T00:00:00.000Z',
  };

  const GOOD_TOKEN: AccessTokenRecord = {
    id: 'tok-good',
    accountId: GOOD_ACCOUNT.id,
    sha256: 'a'.repeat(64),
    label: 'laptop',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };

  // sha256 が64文字でない（版ずれで別のハッシュ長を書いた、を模す）。
  const BAD_TOKEN_RAW = {
    id: 'tok-bad',
    accountId: GOOD_ACCOUNT.id,
    sha256: 'too-short',
    label: 'legacy device',
    createdAt: '2026-01-02T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };

  const GOOD_REQUEST: LoginRequest = {
    id: 'login-good',
    provider: 'google',
    nonce: 'nonce-good',
    codeVerifier: 'verifier-good',
    claimSha256: 'b'.repeat(64),
    redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
    label: 'laptop',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
    status: 'pending',
    accountId: null,
    error: null,
  };

  // nonce（必須欄。空文字は schema が拒む）が空。
  const BAD_REQUEST_RAW = {
    id: 'login-bad',
    provider: 'google',
    nonce: '',
    codeVerifier: 'verifier-bad',
    claimSha256: 'c'.repeat(64),
    redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
    label: 'legacy device',
    createdAt: '2026-01-02T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
    status: 'pending',
    accountId: null,
    error: null,
  };

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    authPath = join(root, 'auth', 'auth.json');
  });

  /**
   * auth.json を、4配列それぞれに正しい行1件・schema に合わない行1件で
   * 直接作る（手編集・版ずれを模す）。
   */
  async function writeRawAuthFile(): Promise<void> {
    const stores = createFsStores(root);
    await stores.auth.putAccount(GOOD_ACCOUNT);
    await stores.auth.putIdentity(GOOD_IDENTITY);
    await stores.auth.putAccessToken(GOOD_TOKEN);
    await stores.auth.putLoginRequest(GOOD_REQUEST);
    const raw = JSON.parse(await readFile(authPath, 'utf8')) as {
      accounts: unknown[];
      identities: unknown[];
      accessTokens: unknown[];
      loginRequests: unknown[];
    };
    raw.accounts.push(BAD_ACCOUNT_RAW);
    raw.identities.push(BAD_IDENTITY_RAW);
    raw.accessTokens.push(BAD_TOKEN_RAW);
    raw.loginRequests.push(BAD_REQUEST_RAW);
    await writeFile(authPath, `${JSON.stringify(raw, null, 2)}\n`);
  }

  function rowsWithId(rows: unknown[], id: string): unknown[] {
    return rows.filter(
      (row) => typeof row === 'object' && row !== null && (row as { id?: unknown }).id === id,
    );
  }

  it('listAccounts() / getAccount() は不正な行があっても落ちず、正しい行だけを返す', async () => {
    await writeRawAuthFile();
    const stores = createFsStores(root);

    let list: AuthAccount[] = [];
    let good: AuthAccount | null = null;
    let bad: AuthAccount | null = null;
    await captureStderr(async () => {
      list = await stores.auth.listAccounts();
      good = await stores.auth.getAccount('acct-good');
      bad = await stores.auth.getAccount('acct-bad');
    });

    expect(list.map((a) => a.id)).toEqual(['acct-good']);
    expect(good).toEqual(GOOD_ACCOUNT);
    // **fail-closed**——壊れた行を指す account は「無い」として扱われる
    // （見つからない ⟹ その account を指す token での `authenticate()` は
    // 401 になる。権限が増える方向へは倒れない）。
    expect(bad).toBeNull();
  });

  it('listIdentities() / findIdentity() は不正な行があっても落ちず、正しい行だけを返す', async () => {
    await writeRawAuthFile();
    const stores = createFsStores(root);

    let found: AuthIdentity | null = null;
    let list: AuthIdentity[] = [];
    await captureStderr(async () => {
      found = await stores.auth.findIdentity('google', 'sub-good');
      list = await stores.auth.listIdentities(GOOD_ACCOUNT.id);
    });

    expect(found).toEqual(GOOD_IDENTITY);
    expect(list).toEqual([GOOD_IDENTITY]);
  });

  it('listAccessTokens() / findAccessTokenBySha256() は不正な行があっても落ちず、正しい行だけを返す', async () => {
    await writeRawAuthFile();
    const stores = createFsStores(root);

    let list: AccessTokenRecord[] = [];
    let found: AccessTokenRecord | null = null;
    let byBadSha: AccessTokenRecord | null = null;
    await captureStderr(async () => {
      list = await stores.auth.listAccessTokens(GOOD_ACCOUNT.id);
      found = await stores.auth.findAccessTokenBySha256('a'.repeat(64));
      byBadSha = await stores.auth.findAccessTokenBySha256('too-short');
    });

    expect(list.map((t) => t.id)).toEqual(['tok-good']);
    expect(found).toEqual(GOOD_TOKEN);
    // **fail-closed**——壊れた行の値を提示しても一致する行は見つからない。
    expect(byBadSha).toBeNull();
  });

  it('getLoginRequest() は不正な行があっても落ちない。正しい行は返る', async () => {
    await writeRawAuthFile();
    const stores = createFsStores(root);

    let good: LoginRequest | null = null;
    let bad: LoginRequest | null = null;
    await captureStderr(async () => {
      good = await stores.auth.getLoginRequest('login-good');
      bad = await stores.auth.getLoginRequest('login-bad');
    });

    expect(good).toEqual(GOOD_REQUEST);
    expect(bad).toBeNull();
  });

  it('跡: 飛ばした行を stderr へ出す。email 等の本文は絶対に含めない', async () => {
    await writeRawAuthFile();
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await stores.auth.listAccounts();
      await stores.auth.listIdentities(GOOD_ACCOUNT.id);
      await stores.auth.listAccessTokens(GOOD_ACCOUNT.id);
      await stores.auth.getLoginRequest('login-bad');
    });
    const joined = lines.join('');

    // id（や identities の provider）は載ってよい。
    expect(joined).toContain('acct-bad');
    expect(joined).toContain('google');
    expect(joined).toContain('tok-bad');
    expect(joined).toContain('login-bad');
    // **email はどの行のものも絶対に出ない。**
    expect(joined).not.toContain(GOOD_ACCOUNT.email as string);
    expect(joined).not.toContain(BAD_ACCOUNT_RAW.email);
    expect(joined).not.toContain(BAD_IDENTITY_RAW.email);
  });

  it('putAccount() は壊れた同じ id の行を置き換える（元の壊れた行とは共存しない）', async () => {
    await writeRawAuthFile();
    const stores = createFsStores(root);

    await captureStderr(() =>
      stores.auth.putAccount({ ...GOOD_ACCOUNT, id: 'acct-bad', displayName: '直した' }),
    );

    const raw = JSON.parse(await readFile(authPath, 'utf8')) as { accounts: unknown[] };
    const rows = rowsWithId(raw.accounts, 'acct-bad');
    // **その id は1行だけ**——古い壊れた行と共存しない。
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'acct-bad', displayName: '直した' });
  });

  it('putAccessToken() は壊れた同じ id の行を置き換える', async () => {
    await writeRawAuthFile();
    const stores = createFsStores(root);

    await captureStderr(() =>
      stores.auth.putAccessToken({ ...GOOD_TOKEN, id: 'tok-bad', label: '直した' }),
    );

    const raw = JSON.parse(await readFile(authPath, 'utf8')) as { accessTokens: unknown[] };
    const rows = rowsWithId(raw.accessTokens, 'tok-bad');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'tok-bad', label: '直した' });
  });

  it('putLoginRequest() は壊れた同じ id の行を置き換える', async () => {
    await writeRawAuthFile();
    const stores = createFsStores(root);

    await captureStderr(() =>
      stores.auth.putLoginRequest({ ...GOOD_REQUEST, id: 'login-bad', label: '直した' }),
    );

    const raw = JSON.parse(await readFile(authPath, 'utf8')) as { loginRequests: unknown[] };
    const rows = rowsWithId(raw.loginRequests, 'login-bad');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'login-bad', label: '直した' });
  });

  it(
    'createAccountWithIdentity() —— 壊れた identity 行（既存の許可済み account を' +
      '指していた）を飛ばすと、再ログインは新しい未許可 account を作る。既存の許可を' +
      '引き継がない（fail-closed）。書き戻しは新しい行を勝たせ、古い壊れた行と' +
      '共存させない',
    async () => {
      const existingAccount: AuthAccount = {
        id: 'acct-existing',
        displayName: 'Existing (granted)',
        email: 'existing@example.test',
        createdAt: '2025-01-01T00:00:00.000Z',
        lastLoginAt: '2025-01-01T00:00:00.000Z',
        grantedAt: '2025-01-01T00:00:00.000Z',
        grantedBy: 'operator',
        ownerDeclaredAt: null,
      };
      const stores = createFsStores(root);
      await stores.auth.putAccount(existingAccount);

      // もともとは正しい identity 行だったが、版ずれ・手編集で壊れた——
      // subject（`sub-existing`）はそのまま、`emailVerified`（必須・boolean）
      // が文字列になっている、というシナリオ。`putIdentity()` は schema を
      // 通すのでこの形は作れず、直接ファイルへ書いて再現する。
      const corruptedExistingIdentityRaw = {
        provider: 'google',
        subject: 'sub-existing',
        accountId: existingAccount.id,
        email: existingAccount.email,
        emailVerified: 'yes',
        createdAt: '2025-01-01T00:00:00.000Z',
        lastLoginAt: '2025-01-01T00:00:00.000Z',
      };
      const raw0 = JSON.parse(await readFile(authPath, 'utf8')) as { identities: unknown[] };
      raw0.identities.push(corruptedExistingIdentityRaw);
      await writeFile(authPath, `${JSON.stringify(raw0, null, 2)}\n`);

      // 同じ Google アカウント（同じ provider/subject）がもう一度ログインする
      // ——`findIdentity` は壊れた行を見つけられないので、呼び手は
      // 「初めて見る identity」として `createAccountWithIdentity` を呼ぶ。
      let outcome: Awaited<ReturnType<typeof stores.auth.createAccountWithIdentity>> | null = null;
      await captureStderr(async () => {
        outcome = await stores.auth.createAccountWithIdentity({
          account: {
            id: 'acct-relogin',
            displayName: 'Existing (granted)',
            email: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            lastLoginAt: null,
            grantedAt: null,
            grantedBy: null,
            ownerDeclaredAt: null,
          },
          identity: {
            provider: 'google',
            subject: 'sub-existing',
            accountId: 'acct-relogin',
            email: 'existing@example.test',
            emailVerified: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            lastLoginAt: '2026-01-01T00:00:00.000Z',
          },
        });
      });

      expect(outcome).toEqual({
        created: true,
        account: expect.objectContaining({ id: 'acct-relogin', grantedAt: null }),
      });

      // **fail-closed の核心**——元の account（`acct-existing`。許可済み）の
      // `grantedAt` は引き継がれない。新しい account は未許可のまま。
      const relogin = await stores.auth.getAccount('acct-relogin');
      expect(relogin?.grantedAt).toBeNull();

      // 照会は新しい行を採る。
      const found = await stores.auth.findIdentity('google', 'sub-existing');
      expect(found?.accountId).toBe('acct-relogin');

      // 書き戻しも新しい行を勝たせる——壊れた生の行と新しい行が同じ
      // (provider, subject) で共存しない（1行だけになる）。
      const raw1 = JSON.parse(await readFile(authPath, 'utf8')) as { identities: unknown[] };
      const matching = raw1.identities.filter(
        (row) =>
          typeof row === 'object' &&
          row !== null &&
          (row as { provider?: unknown }).provider === 'google' &&
          (row as { subject?: unknown }).subject === 'sub-existing',
      );
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({ accountId: 'acct-relogin' });
    },
  );
});

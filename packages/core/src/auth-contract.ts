import type {
  AccessTokenRecord,
  AuthAccount,
  AuthIdentity,
  AuthStore,
  LoginRequest,
} from './auth.js';
import { decodeState, sha256Hex } from './auth.js';
import { createAuthProviderRegistry } from './auth-providers.js';
import type { OAuthProfile, OAuthProvider } from './auth-providers.js';
import { createAuthService } from './auth-service.js';
import { expectEqual as sharedExpectEqual, stable } from './contract-assert.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg が core を実行時に読むため。
// 器は `makeAuth` で1ケースごとに空のものを立てて渡す: どのケースも `account-1` のような固定の id で始めるので、器を使い回すと互いに汚れる。
// 呼び出し側は、立てた器の後始末（pg の接続を閉じるなど）を自分で持つ。

export type MakeAuthStore = () => Promise<AuthStore> | AuthStore;

function fail(area: string, message: string): never {
  throw new Error(`AuthStore の契約違反（${area}）: ${message}`);
}

function expectEqual(area: string, label: string, actual: unknown, expected: unknown): void {
  sharedExpectEqual((message) => fail(area, message), label, actual, expected);
}

async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

const BASE = '2026-01-01T00:00:00.000Z';

const ACCOUNT: AuthAccount = {
  id: 'account-1',
  displayName: 'Owner',
  email: 'owner@example.test',
  createdAt: BASE,
  lastLoginAt: BASE,
  grantedAt: null,
  grantedBy: null,
};

function identityOf(
  subject: string,
  email: string,
  createdAt: string,
  lastLoginAt: string,
): AuthIdentity {
  return {
    provider: 'google',
    subject,
    accountId: 'account-1',
    email,
    emailVerified: true,
    createdAt,
    lastLoginAt,
  };
}

function tokenOf(id: string, sha: string, label: string, createdAt: string): AccessTokenRecord {
  return {
    id,
    accountId: 'account-1',
    sha256: sha.repeat(64),
    label,
    createdAt,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };
}

function loginRequestOf(id: string, over: Partial<LoginRequest> = {}): LoginRequest {
  return {
    id,
    provider: 'google',
    nonce: 'nonce',
    codeVerifier: 'verifier',
    claimSha256: 'c'.repeat(64),
    redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
    label: '',
    createdAt: BASE,
    expiresAt: '2999-01-01T00:00:00.000Z',
    status: 'pending',
    accountId: null,
    error: null,
    ...over,
  };
}

function neverIssued(): never {
  throw new Error('引き取れないはずの要求でトークンを作ろうとした');
}

function issuedFor(consumed: LoginRequest, id: string, shaChar: string): AccessTokenRecord {
  return {
    id,
    accountId: consumed.accountId ?? '',
    sha256: shaChar.repeat(64),
    label: consumed.label,
    createdAt: '2026-01-02T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };
}

/** アカウント・identity・アクセストークン・ログイン要求の保存と読み戻し。 */
export async function verifyAuthRecordsContract(makeAuth: MakeAuthStore): Promise<void> {
  const area = '保存と読み戻し';

  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    expectEqual(area, 'getAccount', await store.getAccount('account-1'), ACCOUNT);
    expectEqual(area, 'listAccounts', await store.listAccounts(), [ACCOUNT]);
    expectEqual(area, '居ない account', await store.getAccount('居ない'), null);
  }

  // 許可の2値を書き換えられる（alteroid access grant の実体）
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await store.putAccount({
      ...ACCOUNT,
      grantedAt: '2026-01-02T00:00:00.000Z',
      grantedBy: 'operator',
    });
    const stored = await store.getAccount('account-1');
    expectEqual(area, 'grantedAt', stored?.grantedAt, '2026-01-02T00:00:00.000Z');
    expectEqual(area, 'grantedBy', stored?.grantedBy, 'operator');
    expectEqual(area, '書き換えても account が増えない', (await store.listAccounts()).length, 1);
  }

  // 検証済みメールからアカウントを引ける（相乗りの検査に使う）
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    expectEqual(
      area,
      'findAccountByEmail',
      (await store.findAccountByEmail('owner@example.test'))?.id,
      'account-1',
    );
    expectEqual(area, '別のメール', await store.findAccountByEmail('別人@example.test'), null);
  }

  // identity は (provider, subject) で一意（同じ人の入り直しで増えない）
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    const identity = identityOf('sub-1', 'owner@example.test', BASE, BASE);
    await store.putIdentity(identity);
    await store.putIdentity({ ...identity, lastLoginAt: '2026-01-05T00:00:00.000Z' });
    const identities = await store.listIdentities('account-1');
    expectEqual(area, '入り直しで identity が増えない', identities.length, 1);
    expectEqual(
      area,
      '入り直しの lastLoginAt',
      identities[0]?.lastLoginAt,
      '2026-01-05T00:00:00.000Z',
    );
    expectEqual(
      area,
      'findIdentity',
      (await store.findIdentity('google', 'sub-1'))?.accountId,
      'account-1',
    );
    expectEqual(area, '別の sub', await store.findIdentity('google', '別の sub'), null);
  }

  // アクセストークンは sha256 で引ける（素の値は持たない）
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    const token: AccessTokenRecord = {
      ...tokenOf('token-1', 'a', 'laptop', BASE),
      expiresAt: '2026-02-01T00:00:00.000Z',
    };
    await store.putAccessToken(token);
    expectEqual(
      area,
      'findAccessTokenBySha256',
      await store.findAccessTokenBySha256('a'.repeat(64)),
      token,
    );
    expectEqual(area, '別の sha256', await store.findAccessTokenBySha256('b'.repeat(64)), null);
    expectEqual(area, 'listAccessTokens', await store.listAccessTokens('account-1'), [token]);
  }

  // ログイン要求を保存して読み戻せる（ブラウザ往復の突き合わせ）
  {
    const store = await makeAuth();
    const request = loginRequestOf('login-1', { label: 'laptop' });
    await store.putLoginRequest(request);
    expectEqual(area, 'getLoginRequest', await store.getLoginRequest('login-1'), request);
    await store.putLoginRequest({ ...request, status: 'consumed' });
    expectEqual(
      area,
      '書き換えた status',
      (await store.getLoginRequest('login-1'))?.status,
      'consumed',
    );
    expectEqual(area, '居ない要求', await store.getLoginRequest('居ない'), null);
  }
}

/** 一覧の並び: createdAt の実時刻順（オフセット表記が違っても崩れない）と、同着の2次キー（issue #1688）。 */
export async function verifyAuthListOrderContract(makeAuth: MakeAuthStore): Promise<void> {
  const area = '一覧の並び';
  const TIE = '2026-01-05T00:00:00.000Z';

  // listAccounts は createdAt の実時刻順（オフセット表記が違っても崩れない）
  {
    const store = await makeAuth();
    await store.putAccount({
      ...ACCOUNT,
      id: 'account-early-utc',
      email: 'early@example.test',
      createdAt: '2024-01-01T23:00:00+09:00',
    });
    await store.putAccount({
      ...ACCOUNT,
      id: 'account-late-utc',
      email: 'late@example.test',
      createdAt: '2024-01-01T15:00:00+00:00',
    });
    expectEqual(
      area,
      'listAccounts（オフセット表記違い）',
      (await store.listAccounts()).map((it) => it.id),
      ['account-early-utc', 'account-late-utc'],
    );
  }

  // listIdentities は createdAt の実時刻順（後から lastLoginAt を更新しても順が動かない）
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    const first = identityOf('sub-first', 'first@example.test', BASE, BASE);
    const second = identityOf(
      'sub-second',
      'second@example.test',
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    );
    await store.putIdentity(first);
    await store.putIdentity(second);
    await store.putIdentity({ ...first, lastLoginAt: '2026-01-03T00:00:00.000Z' });
    expectEqual(
      area,
      'listIdentities（更新しても動かない）',
      (await store.listIdentities('account-1')).map((it) => it.subject),
      ['sub-first', 'sub-second'],
    );
  }

  // listIdentities は createdAt の実時刻順で返す（新しい行を先に入れても）
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await store.putIdentity(
      identityOf(
        'sub-second',
        'second@example.test',
        '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
      ),
    );
    await store.putIdentity(identityOf('sub-first', 'first@example.test', BASE, BASE));
    expectEqual(
      area,
      'listIdentities（逆順に入れた）',
      (await store.listIdentities('account-1')).map((it) => it.subject),
      ['sub-first', 'sub-second'],
    );
  }

  // listAccessTokens は createdAt の実時刻順（後から lastUsedAt を更新しても順が動かない）
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    const first = tokenOf('token-first', 'a', 'first', BASE);
    const second = tokenOf('token-second', 'b', 'second', '2026-01-02T00:00:00.000Z');
    await store.putAccessToken(first);
    await store.putAccessToken(second);
    await store.putAccessToken({ ...first, lastUsedAt: '2026-01-03T00:00:00.000Z' });
    expectEqual(
      area,
      'listAccessTokens（更新しても動かない）',
      (await store.listAccessTokens('account-1')).map((it) => it.id),
      ['token-first', 'token-second'],
    );
  }

  // listAccessTokens は createdAt の実時刻順で返す（新しい行を先に入れても）
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await store.putAccessToken(tokenOf('token-second', 'b', 'second', '2026-01-02T00:00:00.000Z'));
    await store.putAccessToken(tokenOf('token-first', 'a', 'first', BASE));
    expectEqual(
      area,
      'listAccessTokens（逆順に入れた）',
      (await store.listAccessTokens('account-1')).map((it) => it.id),
      ['token-first', 'token-second'],
    );
  }

  // 同着: 先に作ったほうだけ後から更新しても動かない。2次キーと逆順に挿入しても2次キー昇順
  {
    const store = await makeAuth();
    const first = { ...ACCOUNT, id: 'account-a', email: 'a@example.test', createdAt: TIE };
    const second = { ...ACCOUNT, id: 'account-b', email: 'b@example.test', createdAt: TIE };
    await store.putAccount(first);
    await store.putAccount(second);
    await store.putAccount({ ...first, displayName: 'Owner (renamed)' });
    expectEqual(
      area,
      'listAccounts: 同着の2行のうち先に作ったほうだけ更新',
      (await store.listAccounts()).map((it) => it.id),
      ['account-a', 'account-b'],
    );
  }
  {
    const store = await makeAuth();
    await store.putAccount({
      ...ACCOUNT,
      id: 'account-z',
      email: 'z@example.test',
      createdAt: TIE,
    });
    await store.putAccount({
      ...ACCOUNT,
      id: 'account-a',
      email: 'a@example.test',
      createdAt: TIE,
    });
    expectEqual(
      area,
      'listAccounts: 同着2行を2次キーと逆順に挿入',
      (await store.listAccounts()).map((it) => it.id),
      ['account-a', 'account-z'],
    );
  }
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    const first = identityOf('sub-first', 'first@example.test', TIE, TIE);
    const second = identityOf('sub-second', 'second@example.test', TIE, TIE);
    await store.putIdentity(first);
    await store.putIdentity(second);
    await store.putIdentity({ ...first, lastLoginAt: '2026-01-06T00:00:00.000Z' });
    expectEqual(
      area,
      'listIdentities: 同着の2行のうち先に作ったほうだけ更新',
      (await store.listIdentities('account-1')).map((it) => it.subject),
      ['sub-first', 'sub-second'],
    );
  }
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await store.putIdentity(identityOf('sub-z', 'z@example.test', TIE, TIE));
    await store.putIdentity(identityOf('sub-a', 'a@example.test', TIE, TIE));
    expectEqual(
      area,
      'listIdentities: 同着2行を2次キーと逆順に挿入',
      (await store.listIdentities('account-1')).map((it) => it.subject),
      ['sub-a', 'sub-z'],
    );
  }
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    const first = tokenOf('token-first', 'a', 'first', TIE);
    const second = tokenOf('token-second', 'b', 'second', TIE);
    await store.putAccessToken(first);
    await store.putAccessToken(second);
    await store.putAccessToken({ ...first, lastUsedAt: '2026-01-06T00:00:00.000Z' });
    expectEqual(
      area,
      'listAccessTokens: 同着の2行のうち先に作ったほうだけ更新',
      (await store.listAccessTokens('account-1')).map((it) => it.id),
      ['token-first', 'token-second'],
    );
  }
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await store.putAccessToken(tokenOf('token-z', 'a', 'z', TIE));
    await store.putAccessToken(tokenOf('token-a', 'b', 'a', TIE));
    expectEqual(
      area,
      'listAccessTokens: 同着2行を2次キーと逆順に挿入',
      (await store.listAccessTokens('account-1')).map((it) => it.id),
      ['token-a', 'token-z'],
    );
  }
}

/** 同着の2次キーは文字の順（バイト順）で並ぶ（issue #2458）。 */
export async function verifyAuthTieByteOrderContract(makeAuth: MakeAuthStore): Promise<void> {
  const area = '同着の2次キーのバイト順';
  const TIE = '2026-01-05T00:00:00.000Z';
  const INSERT_ORDER = ['ab', 'a-x', '_z', 'B_x', 'Ab', '9'];
  const EXPECTED = ['9', 'Ab', 'B_x', '_z', 'a-x', 'ab'];
  const PROVIDER_INSERT_ORDER = ['ab', 'a_b', 'a0', 'a-b'];
  const PROVIDER_EXPECTED = ['a-b', 'a0', 'a_b', 'ab'];

  const account = (id: string): AuthAccount => ({
    id,
    displayName: null,
    email: null,
    createdAt: TIE,
    lastLoginAt: null,
    grantedAt: null,
    grantedBy: null,
  });
  const identity = (provider: string, subject: string): AuthIdentity => ({
    provider,
    subject,
    accountId: 'account-1',
    email: null,
    emailVerified: false,
    createdAt: TIE,
    lastLoginAt: TIE,
  });
  const token = (id: string, n: number): AccessTokenRecord => ({
    id,
    accountId: 'account-1',
    sha256: n.toString(16).padStart(64, '0'),
    label: id,
    createdAt: TIE,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  });
  const owner = (): AuthAccount => ({ ...account('account-1'), createdAt: BASE });

  {
    const store = await makeAuth();
    for (const id of INSERT_ORDER) await store.putAccount(account(id));
    expectEqual(
      area,
      'listAccounts: 同着の id',
      (await store.listAccounts()).map((it) => it.id),
      EXPECTED,
    );
  }
  {
    const store = await makeAuth();
    await store.putAccount(owner());
    for (const subject of INSERT_ORDER) await store.putIdentity(identity('google', subject));
    expectEqual(
      area,
      'listIdentities: 同着の subject',
      (await store.listIdentities('account-1')).map((it) => it.subject),
      EXPECTED,
    );
  }
  {
    const store = await makeAuth();
    await store.putAccount(owner());
    for (const provider of PROVIDER_INSERT_ORDER) await store.putIdentity(identity(provider, 's'));
    expectEqual(
      area,
      'listIdentities: 同着の provider',
      (await store.listIdentities('account-1')).map((it) => it.provider),
      PROVIDER_EXPECTED,
    );
  }
  {
    const store = await makeAuth();
    await store.putAccount(owner());
    let n = 1;
    for (const id of INSERT_ORDER) await store.putAccessToken(token(id, n++));
    expectEqual(
      area,
      'listAccessTokens: 同着の id',
      (await store.listAccessTokens('account-1')).map((it) => it.id),
      EXPECTED,
    );
  }
}

/** アクセストークンの失効（revokeAccessToken）と使用の記録（markAccessTokenUsed）。 */
export async function verifyAuthRevokeAccessTokenContract(makeAuth: MakeAuthStore): Promise<void> {
  const area = 'revokeAccessToken';
  const token = tokenOf('token-1', 'a', 'laptop', BASE);

  // 失効させる（revokedAt が立ち、他のトークンは影響を受けない）
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await store.putAccessToken(token);
    await store.putAccessToken({ ...token, id: 'token-2', sha256: 'b'.repeat(64) });

    const result = await store.revokeAccessToken('token-1', '2026-01-02T00:00:00.000Z');
    expectEqual(area, '失効の結果', result, {
      status: 'revoked',
      token: { ...token, revokedAt: '2026-01-02T00:00:00.000Z' },
    });
    expectEqual(
      area,
      '失効した token の revokedAt',
      (await store.findAccessTokenBySha256('a'.repeat(64)))?.revokedAt,
      '2026-01-02T00:00:00.000Z',
    );
    expectEqual(
      area,
      '他の token の revokedAt',
      (await store.findAccessTokenBySha256('b'.repeat(64)))?.revokedAt,
      null,
    );
  }

  // もう一度呼んでも、先に立った時刻を動かさない（冪等）
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await store.putAccessToken(token);
    await store.revokeAccessToken('token-1', '2026-01-02T00:00:00.000Z');
    const second = await store.revokeAccessToken('token-1', '2026-01-03T00:00:00.000Z');
    expectEqual(area, '2回目の結果', second, {
      status: 'already_revoked',
      token: { ...token, revokedAt: '2026-01-02T00:00:00.000Z' },
    });
    expectEqual(
      area,
      '2回目の後の revokedAt',
      (await store.findAccessTokenBySha256('a'.repeat(64)))?.revokedAt,
      '2026-01-02T00:00:00.000Z',
    );
  }

  // 無い id は not_found
  {
    const store = await makeAuth();
    expectEqual(
      area,
      '居ない id',
      await store.revokeAccessToken('居ない', '2026-01-02T00:00:00.000Z'),
      { status: 'not_found' },
    );
  }

  // markAccessTokenUsed は lastUsedAt だけを書き、失効済みと無い id には書かない（issue #1782）
  {
    const store = await makeAuth();
    const marked: AccessTokenRecord = {
      ...tokenOf('token-mark', 'b', 'laptop', '2026-09-01T00:00:00.000Z'),
      accountId: 'account-mark',
    };
    await store.putAccessToken(marked);

    await store.markAccessTokenUsed(marked.id, '2026-09-02T00:00:00.000Z');
    const used = await store.findAccessTokenBySha256(marked.sha256);
    expectEqual(
      area,
      'markAccessTokenUsed の lastUsedAt',
      used?.lastUsedAt,
      '2026-09-02T00:00:00.000Z',
    );
    expectEqual(area, 'markAccessTokenUsed の revokedAt', used?.revokedAt, null);

    await store.revokeAccessToken(marked.id, '2026-09-03T00:00:00.000Z');
    await store.markAccessTokenUsed(marked.id, '2026-09-04T00:00:00.000Z');
    const afterRevoke = await store.findAccessTokenBySha256(marked.sha256);
    expectEqual(area, '失効後の revokedAt', afterRevoke?.revokedAt, '2026-09-03T00:00:00.000Z');
    expectEqual(area, '失効後の lastUsedAt', afterRevoke?.lastUsedAt, '2026-09-02T00:00:00.000Z');

    expectEqual(
      area,
      '無い id への markAccessTokenUsed',
      await store.markAccessTokenUsed('no-such-token', '2026-09-05T00:00:00.000Z'),
      undefined,
    );
  }
}

/** アカウントの欄ごとの書き込み（markAccountLoggedIn・revokeAccountAccess、issue #1870・#1915）。 */
export async function verifyAuthAccountFieldsContract(makeAuth: MakeAuthStore): Promise<void> {
  const area = 'アカウントの欄ごとの書き込み';

  // markAccountLoggedIn は lastLoginAt だけを書き、grantedAt / grantedBy には触れない。無い id では何もしない
  {
    const store = await makeAuth();
    const account: AuthAccount = {
      id: 'account-mark',
      displayName: 'Alice',
      email: 'alice@example.test',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastLoginAt: '2026-09-01T00:00:00.000Z',
      grantedAt: '2026-09-02T00:00:00.000Z',
      grantedBy: 'operator',
    };
    await store.putAccount(account);

    await store.markAccountLoggedIn(account.id, '2026-09-04T00:00:00.000Z');
    expectEqual(area, 'markAccountLoggedIn', await store.getAccount(account.id), {
      ...account,
      lastLoginAt: '2026-09-04T00:00:00.000Z',
    });
    expectEqual(
      area,
      '無い id への markAccountLoggedIn',
      await store.markAccountLoggedIn('no-such-account', '2026-09-05T00:00:00.000Z'),
      undefined,
    );
  }

  // revokeAccountAccess は grantedAt / grantedBy だけを null にし、他の欄には触れない。無い id では何もしない
  {
    const store = await makeAuth();
    const account: AuthAccount = {
      id: 'account-revoke',
      displayName: 'Alice',
      email: 'alice@example.test',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastLoginAt: '2026-09-04T00:00:00.000Z',
      grantedAt: '2026-09-02T00:00:00.000Z',
      grantedBy: 'operator',
    };
    await store.putAccount(account);

    await store.revokeAccountAccess(account.id);
    expectEqual(area, 'revokeAccountAccess', await store.getAccount(account.id), {
      ...account,
      grantedAt: null,
      grantedBy: null,
    });
    expectEqual(
      area,
      '無い id への revokeAccountAccess',
      await store.revokeAccountAccess('no-such-account'),
      undefined,
    );
  }
}

/** ログイン要求の引き取り（claim）と交換への着手（beginLoginExchange）。 */
export async function verifyAuthLoginRequestContract(makeAuth: MakeAuthStore): Promise<void> {
  const area = 'ログイン要求';

  // 引き取りは1回だけ成功する（並行でも二重発行させない）
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await store.putLoginRequest(
      loginRequestOf('login-2', {
        claimSha256: 'd'.repeat(64),
        label: 'laptop',
        status: 'authenticated',
        accountId: 'account-1',
      }),
    );

    // 読んでから書く形だと、ここで全部が authenticated を掴んでしまう。
    let issued = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.claimLoginRequest('login-2', (request) => {
          issued += 1;
          return issuedFor(request, `token-race-${issued}`, String(issued));
        }),
      ),
    );
    expectEqual(area, '引き取れた数', results.filter((r) => r !== null).length, 1);
    expectEqual(
      area,
      '引き取り後の status',
      (await store.getLoginRequest('login-2'))?.status,
      'consumed',
    );
    // 保存されたトークンも1本だけ見る: 応答が1件でも器に2本あれば通ってしまうため
    expectEqual(
      area,
      '保存されたトークンの数',
      (await store.listAccessTokens('account-1')).length,
      1,
    );
    expectEqual(
      area,
      '2回目の引き取り',
      await store.claimLoginRequest('login-2', () => neverIssued()),
      null,
    );
  }

  // pending のログイン要求は引き取れない（ブラウザ側が終わる前に発行しない）
  {
    const store = await makeAuth();
    await store.putLoginRequest(loginRequestOf('login-3', { claimSha256: 'e'.repeat(64) }));
    expectEqual(
      area,
      'pending の引き取り',
      await store.claimLoginRequest('login-3', () => neverIssued()),
      null,
    );
    expectEqual(
      area,
      'pending のまま',
      (await store.getLoginRequest('login-3'))?.status,
      'pending',
    );
    expectEqual(
      area,
      '居ない要求の引き取り',
      await store.claimLoginRequest('居ない', () => neverIssued()),
      null,
    );
  }

  // トークンの保存が落ちたら、ログイン要求は authenticated のまま残る
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await store.putLoginRequest(
      loginRequestOf('login-4', {
        claimSha256: 'f'.repeat(64),
        status: 'authenticated',
        accountId: 'account-1',
      }),
    );
    // 消費だけ先に確定してしまうと、トークンは返らないのに二度と引き取れなくなる。
    const threw = await rejects(() =>
      store.claimLoginRequest('login-4', () => {
        throw new Error('トークンを作れなかった');
      }),
    );
    if (!threw) fail(area, 'issue() が投げたのに claimLoginRequest が投げない');
    expectEqual(
      area,
      '失敗後の status',
      (await store.getLoginRequest('login-4'))?.status,
      'authenticated',
    );

    const claimed = await store.claimLoginRequest('login-4', (request) =>
      issuedFor(request, 'token-4', 'b'),
    );
    expectEqual(area, '引き直した token', claimed?.token.id, 'token-4');
    expectEqual(
      area,
      '引き直した後の status',
      (await store.getLoginRequest('login-4'))?.status,
      'consumed',
    );
    expectEqual(
      area,
      '引き直した後のトークン数',
      (await store.listAccessTokens('account-1')).length,
      1,
    );
  }

  // 交換へ進む権利は1つのリクエストしか取れない
  {
    const store = await makeAuth();
    await store.putLoginRequest(loginRequestOf('login-5', { claimSha256: 'a'.repeat(64) }));
    // 読んでから書く形だと、全部が pending を通過して全部が交換へ進む。
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.beginLoginExchange('login-5')),
    );
    expectEqual(area, '交換へ進めた数', results.filter((r) => r !== null).length, 1);
    expectEqual(
      area,
      '交換中の status',
      (await store.getLoginRequest('login-5'))?.status,
      'processing',
    );
    expectEqual(
      area,
      '2回目の beginLoginExchange',
      await store.beginLoginExchange('login-5'),
      null,
    );
    expectEqual(
      area,
      '居ない要求の beginLoginExchange',
      await store.beginLoginExchange('居ない'),
      null,
    );
  }
}

/** 同時の許可（grantAccess）と、同時のアカウント作成（createAccountWithIdentity）。 */
export async function verifyAuthConcurrentWritesContract(makeAuth: MakeAuthStore): Promise<void> {
  const area = '同時の書き込み';
  const at = '2026-01-02T00:00:00.000Z';

  // 別々のアカウントへ同時に grant すると、両方通る（上限が無い）
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await store.putAccount({ ...ACCOUNT, id: 'account-2', email: 'other@example.test' });
    const results = await Promise.all([
      store.grantAccess('account-1', at, 'operator'),
      store.grantAccess('account-2', at, 'operator'),
    ]);
    expectEqual(area, '通った grant の数', results.filter((r) => r.status === 'granted').length, 2);
    expectEqual(
      area,
      '許可済みの account の数',
      (await store.listAccounts()).filter((it) => it.grantedAt !== null).length,
      2,
    );
  }

  // 同じアカウントへ同時に grant しても、grantedBy は先に書いた側のまま
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    const results = await Promise.all([
      store.grantAccess('account-1', at, 'operator'),
      store.grantAccess('account-1', at, 'account-9'),
    ]);
    if (!results.every((r) => r.status === 'granted'))
      fail(area, '同じアカウントへの grant が通らない');
    const stored = (await store.listAccounts()).find((it) => it.id === 'account-1');
    // 2つの応答が器の中身と一致すること。片方が自分の書いた値を返すと、
    // 呼び出し側は「自分が通した」と読んで日誌にそう書く。
    expectEqual(
      area,
      '応答の grantedBy',
      results.map((r) => (r.status === 'granted' ? r.account.grantedBy : null)),
      [stored?.grantedBy, stored?.grantedBy],
    );
  }

  const input = (accountId: string, subject: string, email: string | null) => ({
    account: {
      id: accountId,
      displayName: 'Someone',
      email,
      createdAt: BASE,
      lastLoginAt: BASE,
      grantedAt: null,
      grantedBy: null,
    },
    identity: {
      provider: 'google',
      subject,
      accountId,
      email: email ?? 'race@example.test',
      emailVerified: true,
      createdAt: BASE,
      lastLoginAt: BASE,
    },
  });

  // createAccountWithIdentity を同じ identity で並行に呼んでも、1つだけ作られる（負けた側の account は孤児にならない）
  {
    const store = await makeAuth();
    const results = await Promise.all([
      store.createAccountWithIdentity(input('account-race-a', 'sub-race', null)),
      store.createAccountWithIdentity(input('account-race-b', 'sub-race', null)),
    ]);
    expectEqual(area, '作れた数', results.filter((r) => r.created).length, 1);
    const loser = results.find((r) => !r.created);
    if (loser === undefined || loser.created) fail(area, '負けた側が無い');
    expectEqual(area, '負けた側の existing.subject', loser.existing.subject, 'sub-race');
    const a = await store.listIdentities('account-race-a');
    const b = await store.listIdentities('account-race-b');
    expectEqual(area, 'identity の数', a.length + b.length, 1);
    expectEqual(
      area,
      'account の数（孤児になっていない）',
      (await store.listAccounts()).filter((it) => it.id.startsWith('account-race-')).length,
      1,
    );
  }

  // 2つの候補が同じ identity・同じ検証済みメールを持っていても、投げずに1つだけ作られる
  {
    const store = await makeAuth();
    const results = await Promise.all([
      store.createAccountWithIdentity(
        input('account-email-race-a', 'sub-email-race', 'shared@example.test'),
      ),
      store.createAccountWithIdentity(
        input('account-email-race-b', 'sub-email-race', 'shared@example.test'),
      ),
    ]);
    expectEqual(
      area,
      '同じ identity・同じメールで作れた数',
      results.filter((r) => r.created).length,
      1,
    );
    const loser = results.find((r) => !r.created);
    if (loser === undefined || loser.created) fail(area, '同じメールの負けた側が無い');
    expectEqual(
      area,
      '同じメールの負けた側の existing.subject',
      loser.existing.subject,
      'sub-email-race',
    );
    const accounts = (await store.listAccounts()).filter((it) =>
      it.id.startsWith('account-email-race-'),
    );
    expectEqual(area, '同じメールの account の数', accounts.length, 1);
    expectEqual(area, '同じメールの account の email', accounts[0]?.email, 'shared@example.test');
  }

  // 別々の identity・同じ候補メールで並行に呼んでも、投げずにメールが載るのは1つだけ
  {
    const store = await makeAuth();
    const results = await Promise.all([
      store.createAccountWithIdentity(
        input('account-diff-identity-a', 'sub-diff-a', 'shared@example.test'),
      ),
      store.createAccountWithIdentity(
        input('account-diff-identity-b', 'sub-diff-b', 'shared@example.test'),
      ),
    ]);
    if (!results.every((r) => r.created)) fail(area, '別々の identity なのに作れなかった');
    const emails = results.map((r) => (r.created ? r.account.email : null));
    expectEqual(area, '応答でメールが載った数', emails.filter((e) => e !== null).length, 1);
    const accounts = (await store.listAccounts()).filter((it) =>
      it.id.startsWith('account-diff-identity-'),
    );
    expectEqual(area, 'account の数', accounts.length, 2);
    expectEqual(
      area,
      'メールが載った account の数',
      accounts.filter((it) => it.email !== null).length,
      1,
    );
  }
}

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

const FAKE_REDIRECT = 'http://127.0.0.1:4517/auth/fake/callback';

/** 同じ検証済みメール（大小文字だけの違いを含む）の扱い（#1702・#1741・#1714）。 */
export async function verifyAuthVerifiedEmailContract(makeAuth: MakeAuthStore): Promise<void> {
  const area = '検証済みメール';
  const alice: OAuthProfile = {
    subject: 'sub-alice',
    email: 'alice@example.test',
    emailVerified: true,
    displayName: 'Alice',
  };

  type Service = ReturnType<typeof createAuthService>;
  const serviceOf = (store: AuthStore, profiles: Record<string, OAuthProfile>): Service =>
    createAuthService({ store, providers: createAuthProviderRegistry([fakeProvider(profiles)]) });

  async function start(service: Service) {
    const started = await service.startLogin({ provider: 'fake', redirectUri: FAKE_REDIRECT });
    const state = decodeState(new URL(started.authorizationUrl).searchParams.get('state') ?? '');
    if (state === null) fail(area, 'startLogin の state が読めない');
    return { started, state: `${state.requestId}.${state.nonce}` };
  }

  async function login(service: Service, code: string) {
    const { started, state } = await start(service);
    const completed = await service.completeLogin({ state, code });
    expectEqual(area, `completeLogin(${code})`, completed.status, 'ok');
    return { requestId: started.requestId, claimSecret: started.claimSecret };
  }

  // 同時に2つのログインを完了させる。reject が起きても見逃さないよう、`allSettled` ではなく `Promise.all` で待つ。
  async function loginTogether(service: Service, codeA: string, codeB: string) {
    const first = await start(service);
    const second = await start(service);
    const [resultA, resultB] = await Promise.all([
      service.completeLogin({ state: first.state, code: codeA }),
      service.completeLogin({ state: second.state, code: codeB }),
    ]);
    if (resultA.status !== 'ok' || resultB.status !== 'ok') {
      fail(area, `ログインできていない: ${stable([resultA.status, resultB.status])}`);
    }
    return { resultA, resultB };
  }

  // 大小文字だけが違う検証済みメールも衝突として検出し、2つ目のアカウントには乗せない
  {
    const store = await makeAuth();
    const service = serviceOf(store, {
      'code-alice': alice,
      'code-impostor-case': {
        subject: 'sub-impostor-case',
        email: 'ALICE@EXAMPLE.TEST',
        emailVerified: true,
        displayName: 'Not Alice (case)',
      },
    });
    const claimedAlice = await service.claim(await login(service, 'code-alice'));
    if (claimedAlice.status !== 'ready') fail(area, 'alice がログインできていない');
    expectEqual(area, 'alice の email', claimedAlice.account.email, 'alice@example.test');

    const claimedImpostor = await service.claim(await login(service, 'code-impostor-case'));
    if (claimedImpostor.status !== 'ready') fail(area, '大小文字違いがログインできていない');
    if (claimedImpostor.account.id === claimedAlice.account.id) {
      fail(area, '大小文字だけが違うメールが同じアカウントに乗った');
    }
    expectEqual(area, '2つ目のアカウントの email', claimedImpostor.account.email, null);
  }

  // r2: 別々の identity が大小文字だけ違う検証済みメールで同時にログインしても、投げずに検証済みメールを持つアカウントは1つだけ
  // #1741: 大小文字まで同じでも同じ
  for (const [label, code, profile] of [
    [
      'r2（大小文字だけ違う）',
      'code-impostor-case',
      {
        subject: 'sub-impostor-case',
        email: 'ALICE@EXAMPLE.TEST',
        emailVerified: true,
        displayName: 'Not Alice (case)',
      },
    ],
    [
      '#1741（大小文字まで同じ）',
      'code-impostor-samecase',
      {
        subject: 'sub-impostor-samecase',
        email: 'alice@example.test',
        emailVerified: true,
        displayName: 'Not Alice (same case)',
      },
    ],
  ] as const) {
    const store = await makeAuth();
    const service = serviceOf(store, { 'code-alice': alice, [code]: profile });
    const { resultA, resultB } = await loginTogether(service, 'code-alice', code);
    if (resultA.accountId === resultB.accountId)
      fail(area, `${label}: 別々の identity が同じ account になった`);
    const accounts = await store.listAccounts();
    expectEqual(area, `${label}: account の数`, accounts.length, 2);
    expectEqual(
      area,
      `${label}: 検証済みメールを持つ account の数`,
      accounts.filter((it) => it.email !== null).length,
      1,
    );
  }

  // 同じ identity で2つのログインが同時に完了しても、アカウントは1つで両方が同じ accountId になる（issue #1714）
  {
    const store = await makeAuth();
    const service = serviceOf(store, {
      'code-alice': {
        subject: 'sub-alice-race',
        email: 'alice-race@example.test',
        emailVerified: true,
        displayName: 'Alice',
      },
    });
    const { resultA, resultB } = await loginTogether(service, 'code-alice', 'code-alice');
    expectEqual(area, '同じ identity の accountId', resultA.accountId, resultB.accountId);
    expectEqual(
      area,
      '同じ identity の account の数',
      (await store.listAccounts()).filter((it) => it.email === 'alice-race@example.test').length,
      1,
    );
  }
}

/** ログアウトと同時の authenticate が、失効を巻き戻さない（issue #1782）。 */
export async function verifyAuthLogoutRaceContract(makeAuth: MakeAuthStore): Promise<void> {
  const area = 'authenticate と logout の競合';
  const store = await makeAuth();
  const alice: OAuthProfile = {
    subject: 'sub-alice',
    email: 'alice@example.test',
    emailVerified: true,
    displayName: 'Alice',
  };

  // オブジェクトスプレッドではなく `Proxy` で被せる: メソッドはプロトタイプ側に在り、スプレッドでは写らないため
  const delayGetAccount = (inner: AuthStore, gate: Promise<void>): AuthStore =>
    new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'getAccount') {
          return async (id: string) => {
            await gate;
            return target.getAccount(id);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  let counter = 0;
  const serviceOf = (s: AuthStore) =>
    createAuthService({
      store: s,
      providers: createAuthProviderRegistry([fakeProvider({ unused: alice })]),
      newId: () => `id-${++counter}`,
    });
  const service = serviceOf(store);

  const started = await service.startLogin({ provider: 'fake', redirectUri: FAKE_REDIRECT });
  const state = decodeState(new URL(started.authorizationUrl).searchParams.get('state') ?? '');
  const completed = await service.completeLogin({
    state: `${state?.requestId}.${state?.nonce}`,
    code: 'unused',
  });
  expectEqual(area, 'completeLogin', completed.status, 'ok');
  const claimed = await service.claim({
    requestId: started.requestId,
    claimSecret: started.claimSecret,
  });
  if (claimed.status !== 'ready') fail(area, 'ログインできていない');
  await service.grant(claimed.account.id, 'operator');

  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const racingService = serviceOf(delayGetAccount(store, gate));

  const authenticatePromise = racingService.authenticate(claimed.token);

  expectEqual(area, 'logout', await service.logout(claimed.token), { status: 'ok' });
  const afterLogout = await store.findAccessTokenBySha256(sha256Hex(claimed.token));
  if (afterLogout === null || afterLogout.revokedAt === null) {
    fail(area, 'logout したのに失効していない');
  }

  releaseGate();
  await authenticatePromise;

  const afterTouch = await store.findAccessTokenBySha256(sha256Hex(claimed.token));
  if (afterTouch === null || afterTouch.revokedAt === null) {
    fail(area, '同時の authenticate の touch が失効を巻き戻した');
  }
  expectEqual(area, '失効後の authenticate', await service.authenticate(claimed.token), null);
}

/** 書き込みの形式検査: 形式の不正な入力は throw で拒む。 */
export async function verifyAuthWriteValidationContract(makeAuth: MakeAuthStore): Promise<void> {
  const area = '書き込みの形式検査';
  const mustReject = async (label: string, run: () => Promise<unknown>) => {
    if (!(await rejects(run))) fail(area, `${label}を拒まない（throw しない）`);
  };

  {
    const store = await makeAuth();
    await mustReject('putAccount() の空文字の id', () => store.putAccount({ ...ACCOUNT, id: '' }));
  }
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await mustReject('putIdentity() の空文字の subject', () =>
      store.putIdentity(identityOf('', 'owner@example.test', BASE, BASE)),
    );
  }
  {
    const store = await makeAuth();
    await mustReject('createAccountWithIdentity() の空文字の id の account', () =>
      store.createAccountWithIdentity({
        account: { ...ACCOUNT, id: '' },
        identity: {
          ...identityOf('sub-invalid-account', 'owner@example.test', BASE, BASE),
          accountId: '',
        },
      }),
    );
  }
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await mustReject('putAccessToken() の長さ64でない sha256', () =>
      store.putAccessToken({ ...tokenOf('token-1', 'a', 'laptop', BASE), sha256: 'too-short' }),
    );
  }
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    const token = tokenOf('token-revoke-1', 'a', 'laptop', BASE);
    await store.putAccessToken(token);
    await mustReject('revokeAccessToken() の isoDateTime でない at（issue #1757）', () =>
      store.revokeAccessToken(token.id, '不正な日時'),
    );
  }
  {
    const store = await makeAuth();
    await mustReject('putLoginRequest() の空文字の nonce', () =>
      store.putLoginRequest(loginRequestOf('login-1', { nonce: '', claimSha256: 'a'.repeat(64) })),
    );
  }
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await mustReject('grantAccess() の isoDateTime でない at', () =>
      store.grantAccess(ACCOUNT.id, '不正な日時', 'operator'),
    );
  }
  {
    const store = await makeAuth();
    await store.putAccount(ACCOUNT);
    await store.putLoginRequest(
      loginRequestOf('login-2', {
        claimSha256: 'b'.repeat(64),
        status: 'authenticated',
        accountId: ACCOUNT.id,
      }),
    );
    await mustReject('claimLoginRequest() の issue() が返した長さ64でない sha256', () =>
      store.claimLoginRequest('login-2', (consumed) => ({
        ...issuedFor(consumed, 'token-race', 'x'),
        sha256: 'too-short',
      })),
    );
  }
}

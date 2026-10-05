import type {
  AccessTokenRecord,
  AuthAccount,
  AuthIdentity,
  AuthStore,
  LoginRequest,
} from './auth.js';
import { expectNulRejected } from './nul-contract-support.js';

/**
 * `AuthStore`（accounts・identities・accessTokens・loginRequests）の NUL の約束
 * （issue #3011。teto の判断、2026-10-05・10-06）を、**実装1つに対して**測る。
 * 3実装（インメモリ / fs / pg）が同じ関数を呼ぶ。
 *
 * - **読むだけの口**（鍵で引く select と、「無ければ何もしない」update）は、NUL を含む鍵では
 *   断らず、「無い」と同じ結果を返す。投げない。何も変えない。既存の行の鍵に NUL を足した値
 *   （`<既存の鍵>\u0000`）でも一致しない（pg が落としてから引くと一致してしまう形を縛る）。
 * - **書き込みの口**は、鍵・参照キー・突き合わせに使う値（id・`accountId`・`grantedBy`・`subject`・
 *   トークンの `sha256`・ログイン要求の `nonce` など）の NUL を `NulNotAllowedError` で断り、何も書かない。
 *   本文（`displayName`・`label`・`error`）は NUL を落として残す。例外の文に値を載せない。
 * - メールアドレスは、鍵とも本文とも言えるので、ここでは縛らない（判断待ち）。
 *
 * 呼ぶ前の器は空であること。vitest に依存しない。
 */
export async function verifyAuthNulContract(store: AuthStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`AuthStore の NUL の契約違反: ${message}`);
  }
  const at = '2026-03-01T00:00:00.000Z';
  const base = '2026-01-01T00:00:00.000Z';

  const account: AuthAccount = {
    id: 'auth-nul-account',
    displayName: 'Owner',
    email: null,
    createdAt: base,
    lastLoginAt: base,
    grantedAt: null,
    grantedBy: null,
    ownerDeclaredAt: null,
  };
  const identity: AuthIdentity = {
    provider: 'google',
    subject: 'auth-nul-subject',
    accountId: account.id,
    email: null,
    emailVerified: false,
    createdAt: base,
    lastLoginAt: base,
  };
  const sha = 'a'.repeat(64);
  const token: AccessTokenRecord = {
    id: 'auth-nul-token',
    accountId: account.id,
    sha256: sha,
    label: 'laptop',
    createdAt: base,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };
  const request: LoginRequest = {
    id: 'auth-nul-request',
    provider: 'google',
    nonce: 'nonce-1',
    codeVerifier: 'verifier-1',
    claimSha256: 'b'.repeat(64),
    redirectUri: 'https://example.test/cb',
    label: 'cli',
    createdAt: base,
    expiresAt: '2099-01-01T00:00:00.000Z',
    status: 'authenticated',
    accountId: account.id,
    error: null,
  };
  await store.putAccount(account);
  await store.putIdentity(identity);
  await store.putAccessToken(token);
  await store.putLoginRequest(request);

  const snapshot = async (): Promise<string> =>
    JSON.stringify([
      await store.listAccounts(),
      await store.listIdentities(account.id),
      await store.listAccessTokens(account.id),
      await store.getLoginRequest(request.id),
    ]);
  const before = await snapshot();

  // 1. 読むだけの口: NUL を含む鍵は「無い」と同じ結果。投げない。
  const nulOf = (value: string): string[] => ['n\u0000ul', `${value}\u0000`, `\u0000${value}`];
  const outcomes: Array<[string, () => Promise<unknown>, unknown]> = [];
  for (const key of nulOf(account.id)) {
    outcomes.push(
      ['getAccount', () => store.getAccount(key), null],
      ['listIdentities', () => store.listIdentities(key), []],
      ['listAccessTokens', () => store.listAccessTokens(key), []],
      ['grantAccess', () => store.grantAccess(key, at, 'operator'), { status: 'not_found' }],
      ['setAccountOwner', () => store.setAccountOwner(key, at), { status: 'not_found' }],
      ['setAccountOwner(解除)', () => store.setAccountOwner(key, null), { status: 'not_found' }],
      ['markAccountLoggedIn', () => store.markAccountLoggedIn(key, at), undefined],
      ['revokeAccountAccess', () => store.revokeAccountAccess(key), undefined],
      [
        'removeUnreadableAccounts',
        async () => (await store.removeUnreadableAccounts([key])).kind,
        'unknown',
      ],
    );
  }
  for (const key of nulOf(identity.subject)) {
    outcomes.push(['findIdentity(subject)', () => store.findIdentity('google', key), null]);
  }
  outcomes.push([
    'findIdentity(provider)',
    () => store.findIdentity('goo\u0000gle', identity.subject),
    null,
  ]);
  for (const key of nulOf(sha)) {
    outcomes.push(['findAccessTokenBySha256', () => store.findAccessTokenBySha256(key), null]);
  }
  for (const key of nulOf(token.id)) {
    outcomes.push(
      ['markAccessTokenUsed', () => store.markAccessTokenUsed(key, at), undefined],
      ['revokeAccessToken', () => store.revokeAccessToken(key, at), { status: 'not_found' }],
    );
  }
  for (const key of nulOf(request.id)) {
    outcomes.push(
      ['getLoginRequest', () => store.getLoginRequest(key), null],
      ['beginLoginExchange', () => store.beginLoginExchange(key), null],
      [
        'claimLoginRequest',
        () =>
          store.claimLoginRequest(key, () => {
            throw new Error('issue を呼んではいけない');
          }),
        null,
      ],
    );
  }
  for (const [label, call, expected] of outcomes) {
    let outcome: unknown;
    try {
      outcome = await call();
    } catch (error) {
      fail(
        `${label}(NULを含む鍵)は投げない（投げた: ${error instanceof Error ? error.name : typeof error}）`,
      );
    }
    if (JSON.stringify(outcome) !== JSON.stringify(expected)) {
      fail(`${label}(NULを含む鍵)は「無い」と同じ結果`);
    }
  }
  if ((await snapshot()) !== before) fail('NULを含む鍵で読んだだけなのに行が変わった');

  // 2. 書き込みの口: 鍵・参照キー・突き合わせの値の NUL は断る（値を文に載せない）。何も書かない。
  const secret = 'SECRET-NUL';
  const nul = `${secret}\u0000x`;
  const rejected: Array<[string, () => Promise<unknown>]> = [
    ['putAccount.id', () => store.putAccount({ ...account, id: nul })],
    ['putAccount.grantedBy', () => store.putAccount({ ...account, grantedBy: nul })],
    ['putIdentity.subject', () => store.putIdentity({ ...identity, subject: nul })],
    ['putIdentity.accountId', () => store.putIdentity({ ...identity, accountId: nul })],
    [
      'createAccountWithIdentity.account.id',
      () =>
        store.createAccountWithIdentity({
          account: { ...account, id: nul },
          identity: { ...identity, subject: 'auth-nul-other', accountId: 'auth-nul-other-account' },
        }),
    ],
    [
      'createAccountWithIdentity.identity.subject',
      () =>
        store.createAccountWithIdentity({
          account: { ...account, id: 'auth-nul-other-account' },
          identity: { ...identity, subject: nul, accountId: 'auth-nul-other-account' },
        }),
    ],
    ['putAccessToken.id', () => store.putAccessToken({ ...token, id: nul })],
    ['putAccessToken.accountId', () => store.putAccessToken({ ...token, accountId: nul })],
    [
      'putAccessToken.sha256',
      () =>
        store.putAccessToken({
          ...token,
          sha256: `${secret}\u0000${'c'.repeat(64 - secret.length - 1)}`,
        }),
    ],
    ['putLoginRequest.id', () => store.putLoginRequest({ ...request, id: nul })],
    ['putLoginRequest.nonce', () => store.putLoginRequest({ ...request, nonce: nul })],
    [
      'putLoginRequest.codeVerifier',
      () => store.putLoginRequest({ ...request, codeVerifier: nul }),
    ],
    ['putLoginRequest.redirectUri', () => store.putLoginRequest({ ...request, redirectUri: nul })],
    ['putLoginRequest.accountId', () => store.putLoginRequest({ ...request, accountId: nul })],
    ['grantAccess.by', () => store.grantAccess(account.id, at, nul)],
    [
      'claimLoginRequest.issue(id)',
      () => store.claimLoginRequest(request.id, () => ({ ...token, id: nul })),
    ],
  ];
  for (const [label, call] of rejected) {
    await expectNulRejected(fail, label, call, secret);
  }
  if ((await snapshot()) !== before) fail('NULで断ったのに何かを書いた');
  if ((await store.listAccounts()).length !== 1) fail('NULで断ったのに account が増えた');
  if ((await store.listIdentities('auth-nul-other-account')).length !== 0) {
    fail('NULで断ったのに identity が増えた');
  }

  // 3. 本文の NUL は落として残す。
  await store.putAccount({ ...account, displayName: 'Own\u0000er' });
  if ((await store.getAccount(account.id))?.displayName !== 'Owner')
    fail('displayNameのNULは落として残す');
  await store.putAccessToken({ ...token, label: 'lap\u0000top' });
  if ((await store.listAccessTokens(account.id))[0]?.label !== 'laptop')
    fail('labelのNULは落として残す');
  await store.putLoginRequest({ ...request, label: 'c\u0000li', error: 'e\u0000rr' });
  const readRequest = await store.getLoginRequest(request.id);
  if (readRequest?.label !== 'cli' || readRequest.error !== 'err') {
    fail('ログイン要求の本文（label・error）のNULは落として残す');
  }
  const claimed = await store.claimLoginRequest(request.id, (req) => ({
    ...token,
    id: 'auth-nul-token-2',
    sha256: 'd'.repeat(64),
    label: 'iss\u0000ued',
    accountId: req.accountId ?? account.id,
  }));
  if (claimed?.token.label !== 'issued')
    fail('claim で発行したトークンの label のNULは落として残す');
}

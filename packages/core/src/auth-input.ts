import type { AccessTokenRecord, AuthAccount, AuthIdentity, LoginRequest } from './auth.js';
import { assertNoNul, stripNul } from './nul-guard.js';

export function prepareAccountForWrite(account: AuthAccount): AuthAccount {
  assertNoNul('authAccount.id', account.id);
  if (account.grantedBy !== null) assertNoNul('authAccount.grantedBy', account.grantedBy);
  // NUL を落とさず断る: 検証済みメールの一意の索引と衝突の検査に使う値で、落とすと別のアカウントと一致しうるため
  if (account.email !== null) assertNoNul('authAccount.email', account.email);
  return {
    ...account,
    displayName: account.displayName === null ? null : stripNul(account.displayName),
  };
}

export function prepareIdentityForWrite(identity: AuthIdentity): AuthIdentity {
  assertNoNul('authIdentity.subject', identity.subject);
  assertNoNul('authIdentity.accountId', identity.accountId);
  // NUL を断らず落とす: プロバイダの申告で、ログインのたびに上書きされる表示用の本文のため
  return { ...identity, email: identity.email === null ? null : stripNul(identity.email) };
}

export function prepareAccessTokenForWrite(token: AccessTokenRecord): AccessTokenRecord {
  assertNoNul('accessToken.id', token.id);
  assertNoNul('accessToken.accountId', token.accountId);
  assertNoNul('accessToken.sha256', token.sha256);
  return { ...token, label: stripNul(token.label) };
}

export function prepareLoginRequestForWrite(request: LoginRequest): LoginRequest {
  assertNoNul('loginRequest.id', request.id);
  assertNoNul('loginRequest.nonce', request.nonce);
  assertNoNul('loginRequest.codeVerifier', request.codeVerifier);
  assertNoNul('loginRequest.claimSha256', request.claimSha256);
  assertNoNul('loginRequest.redirectUri', request.redirectUri);
  if (request.accountId !== null) assertNoNul('loginRequest.accountId', request.accountId);
  return {
    ...request,
    label: stripNul(request.label),
    error: request.error === null ? null : stripNul(request.error),
  };
}

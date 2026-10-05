import type { AccessTokenRecord, AuthAccount, AuthIdentity, LoginRequest } from './auth.js';
import { assertNoNul, stripNul } from './nul-guard.js';

/**
 * `AuthStore` の書き込みの入口の NUL の扱い（issue #3011。teto の判断、2026-10-05・10-06）。
 * 3実装（インメモリ / fs / pg）が、zod スキーマを通した後・書く前に呼ぶ。
 *
 * - **鍵と参照キー、突き合わせに使う値は `NulNotAllowedError` で断る。** 落として残すと別の
 *   値になる（id・`accountId`・`grantedBy`・`subject`・トークンの `sha256`・ログイン要求の
 *   `nonce`／`codeVerifier`／`claimSha256`／`redirectUri`）。
 * - **本文は NUL を落として残す**（`displayName`・`label`・`error`）。
 * - **メールアドレス（`AuthAccount.email`・`AuthIdentity.email`）はここでは扱わない。**
 *   鍵（`findAccountByEmail`・一意索引）とも本文（表示用）とも言えるので、判断待ち（issue #3011）。
 *
 * 例外の文には欄名だけを載せ、値は載せない。入力は書き換えず、整えた写しを返す。
 */
export function prepareAccountForWrite(account: AuthAccount): AuthAccount {
  assertNoNul('authAccount.id', account.id);
  if (account.grantedBy !== null) assertNoNul('authAccount.grantedBy', account.grantedBy);
  return {
    ...account,
    displayName: account.displayName === null ? null : stripNul(account.displayName),
  };
}

export function prepareIdentityForWrite(identity: AuthIdentity): AuthIdentity {
  assertNoNul('authIdentity.subject', identity.subject);
  assertNoNul('authIdentity.accountId', identity.accountId);
  return identity;
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

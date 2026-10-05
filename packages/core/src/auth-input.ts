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
 * - **メールアドレス（teto の判断、2026-10-06）**: `AuthAccount.email` は一意の索引と衝突の検査に使う
 *   ので鍵として断る。`AuthIdentity.email` は本文として落として残す。
 *
 * 例外の文には欄名だけを載せ、値は載せない。入力は書き換えず、整えた写しを返す。
 */
export function prepareAccountForWrite(account: AuthAccount): AuthAccount {
  assertNoNul('authAccount.id', account.id);
  if (account.grantedBy !== null) assertNoNul('authAccount.grantedBy', account.grantedBy);
  // 検証済みメールの一意の索引と衝突の検査に使う値。落とすと別のアカウントと一致しうるので断る（teto の判断、2026-10-06）。
  if (account.email !== null) assertNoNul('authAccount.email', account.email);
  return {
    ...account,
    displayName: account.displayName === null ? null : stripNul(account.displayName),
  };
}

export function prepareIdentityForWrite(identity: AuthIdentity): AuthIdentity {
  assertNoNul('authIdentity.subject', identity.subject);
  assertNoNul('authIdentity.accountId', identity.accountId);
  // プロバイダの申告で、ログインのたびに上書きされる表示用の本文。落として残す（teto の判断、2026-10-06）。
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

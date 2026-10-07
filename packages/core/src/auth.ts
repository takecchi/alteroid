import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { UnreadableAccount } from './schema.js';
import type { RemoveUnreadableRowsOptions, RemoveUnreadableRowsResult } from './store.js';

// 許可の2値だけを持つ: 行為別のスコープを持つと、能力を削る仕組みを「認証」の名前で持ち込むことになるため

const isoDateTime = z.string().datetime({ offset: true });

export const authProviderIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

// 外部 identity とは別の層に置く: 後からパスワード認証を足すと identity 表に入るねじれが出て、Google と Discord の両方で入ったときに同一人物へ束ねられなくなるため
export const authAccountSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().nullable(),
  // プロバイダ側の変更で勝手に上書きしない: 本人が選んだ連絡先のため。未検証のメールは identity 側にだけ置く
  email: z.string().nullable(),
  createdAt: isoDateTime,
  lastLoginAt: isoDateTime.nullable(),
  grantedAt: isoDateTime.nullable(),
  // 固定値を書かない: 常に同じ値ならこの欄は情報を運ばないため
  grantedBy: z.string().nullable(),
  // `.default(null)` は必須: 既存の fs の JSON にこの鍵が無く、無いと `parse` が失敗して起動できなくなるため
  ownerDeclaredAt: isoDateTime.nullable().default(null),
});

export const authIdentitySchema = z.object({
  provider: authProviderIdSchema,
  subject: z.string().min(1),
  accountId: z.string().min(1),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  createdAt: isoDateTime,
  lastLoginAt: isoDateTime,
});

export const accessTokenRecordSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  // 素の値は保存しない: 記憶へ到達できる鍵なので、漏れた保管先から復元できてはいけないため
  sha256: z.string().length(64),
  label: z.string(),
  createdAt: isoDateTime,
  expiresAt: isoDateTime.nullable(),
  lastUsedAt: isoDateTime.nullable(),
  revokedAt: isoDateTime.nullable(),
});

// `state` を HMAC で署名しない: この行そのものを突き合わせに使う（サーバ側に置き場があるので署名鍵を増やす必要が無い）
export const loginRequestSchema = z.object({
  id: z.string().min(1),
  provider: authProviderIdSchema,
  nonce: z.string().min(1),
  codeVerifier: z.string().min(1),
  claimSha256: z.string().length(64),
  redirectUri: z.string().min(1),
  label: z.string(),
  createdAt: isoDateTime,
  expiresAt: isoDateTime,
  // `processing` が無いと、同じ callback が並行に届いたとき両方が交換へ進み、失敗した側が古い写しから `failed` を書いて成功側の `authenticated` を上書きしうる
  status: z.enum(['pending', 'processing', 'authenticated', 'consumed', 'failed']),
  accountId: z.string().nullable(),
  error: z.string().nullable(),
});

export type AuthAccount = z.infer<typeof authAccountSchema>;
export type AuthIdentity = z.infer<typeof authIdentitySchema>;
export type AccessTokenRecord = z.infer<typeof accessTokenRecordSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginRequestStatus = LoginRequest['status'];

export interface AuthStore {
  // 文字列の `localeCompare` で並べない: `isoDateTime` はオフセット付きの任意の表記を許すので、同じ瞬間でも文字列比較では実時刻の順が崩れる
  // 同着は `id` の2次キーで決める: 挿入順は fs / pg で保証されないため
  listAccounts(): Promise<AuthAccount[]>;
  // email・identity・アクセストークンは返さない: 中身を含まない形（id と不正な欄名だけ）にするため
  listUnreadableAccounts(): Promise<UnreadableAccount[]>;
  getAccount(id: string): Promise<AuthAccount | null>;
  // 比較の前に小文字化する: 保存するメール自体は正規化しない
  // `completeLogin` はこれを呼ばない: 衝突検査は `createAccountWithIdentity` の1操作の中にある。新しい呼び手を足すときは「読んでから書く」の穴を作っていないか確かめること
  findAccountByEmail(email: string): Promise<AuthAccount | null>;
  putAccount(account: AuthAccount): Promise<void>;
  // `lastLoginAt` 以外を書き戻さない: 読んでから書くまでに完了した grant / revoke / owner 宣言を古い写しで上書きするため
  markAccountLoggedIn(accountId: string, at: string): Promise<void>;
  // 3欄（`grantedAt` / `grantedBy` / `ownerDeclaredAt`）だけを null にする: `lastLoginAt` を古い写しで上書きしないため
  // 行が在るのに読めないときは `UnreadableAccountError` を投げて行は変えない: 「無い」と同じ扱いにすると、後で行が読めるようになったときに許可が生き返るため
  revokeAccountAccess(accountId: string): Promise<void>;
  removeUnreadableAccounts(
    ids: readonly string[],
    options?: RemoveUnreadableRowsOptions,
  ): Promise<RemoveUnreadableRowsResult>;

  findIdentity(provider: string, subject: string): Promise<AuthIdentity | null>;
  // 同着は `provider` → `subject` で決める: `listAccounts` と同じ理由
  listIdentities(accountId: string): Promise<AuthIdentity[]>;
  putIdentity(identity: AuthIdentity): Promise<void>;

  // 「読む → 検査 → 書く」に割らない: 同じ `(provider, subject)` の同時ログインで別々の account ができ、負けた側が二度とログインできなくなるため
  // メールの衝突検査も同じ操作の中に置く（検証済みメールの一意性を壊さない）: 別々の identity が同じ検証済みメールで同時に初回ログインすると、外側の検査は両方とも「衝突なし」を見るため
  // pg で account を先に insert しない: 負けた側が identity の一意制約より先にメールの一意制約違反という別の例外で落ちるため
  createAccountWithIdentity(input: {
    account: AuthAccount;
    identity: AuthIdentity;
  }): Promise<CreateAccountWithIdentityOutcome>;

  putAccessToken(token: AccessTokenRecord): Promise<void>;
  // `lastUsedAt` 以外を書き戻さない: 読んでから書くまでに完了したログアウトの `revokedAt` を古い写しで `null` に戻すため
  // 失効済みのトークンには書かない: 使われた記録を失効したトークンに残さないため
  markAccessTokenUsed(id: string, at: string): Promise<void>;
  findAccessTokenBySha256(sha256: string): Promise<AccessTokenRecord | null>;
  // 同着は `id` で決める: `listAccounts` と同じ理由
  listAccessTokens(accountId: string): Promise<AccessTokenRecord[]>;
  // 先に立っていた `revokedAt` は動かさない: 「読む→検査→書く」に割ると、同時ログアウトで後から来た側が上書きしうるため
  revokeAccessToken(id: string, at: string): Promise<RevokeAccessTokenOutcome>;

  putLoginRequest(request: LoginRequest): Promise<void>;
  getLoginRequest(id: string): Promise<LoginRequest | null>;

  // 読んでから書く形にしない: 同じ `state + code` が並行に届くと両方が `pending` を通過して交換し、失敗した側が古い写しから `failed` を書いて成功側の `authenticated` を上書きするため
  beginLoginExchange(id: string): Promise<LoginRequest | null>;

  // 2つに分けない: 「読む→検査→書く」だと並行送信で両方がトークンを受け取れ、「先に `consumed` にする→後で保存」だと保存失敗でログインを回収できなくなるため
  // `issue` は純粋関数として書く（中で待たない）
  claimLoginRequest(
    id: string,
    issue: (request: LoginRequest) => AccessTokenRecord,
  ): Promise<{ request: LoginRequest; token: AccessTokenRecord } | null>;

  // 同じ account への同時 grant を「読む→検査→書く」に割らない: `grantedAt` / `grantedBy` が後から来た側で上書きされ、日誌の「誰がいつ通したか」と食い違うため
  grantAccess(accountId: string, at: string, by: string): Promise<GrantOutcome>;

  // 「読む→検査→書く」に割らない: 検査と書き込みの間に許可が取り消された行へ宣言が乗る窓ができるため
  // 取り消し（`declaredAt === null`）は行が在れば常に通す: `AuthService.revoke` が許可と宣言を両方落とすため
  setAccountOwner(accountId: string, declaredAt: string | null): Promise<OwnerOutcome>;
}

export type GrantOutcome = { status: 'granted'; account: AuthAccount } | { status: 'not_found' };

export type RevokeAccessTokenOutcome =
  | { status: 'not_found' }
  | { status: 'already_revoked'; token: AccessTokenRecord }
  | { status: 'revoked'; token: AccessTokenRecord };

export type OwnerOutcome =
  { status: 'ok'; account: AuthAccount } | { status: 'not_found' } | { status: 'not_granted' };

// `created: true` の `account` は渡した候補とは限らない: メールが衝突していればメールを空にして保存した版が載るため。呼び手は必ずこの `account` を見る
export type CreateAccountWithIdentityOutcome =
  { created: true; account: AuthAccount } | { created: false; existing: AuthIdentity };

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  // 先に長さを見る: 長さが違うと `timingSafeEqual` が投げる（長さの違いは秘密ではない）
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const ACCESS_TOKEN_PREFIX = 'alt_';

export function issueAccessTokenValue(): string {
  return `${ACCESS_TOKEN_PREFIX}${randomToken(32)}`;
}

// PKCE は必ず付ける: 公開クライアント相当のため
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function encodeState(requestId: string, nonce: string): string {
  return `${requestId}.${nonce}`;
}

export function decodeState(state: string): { requestId: string; nonce: string } | null {
  const separator = state.indexOf('.');
  if (separator <= 0 || separator === state.length - 1) return null;
  return { requestId: state.slice(0, separator), nonce: state.slice(separator + 1) };
}

export function isAccountGranted(account: AuthAccount): boolean {
  return account.grantedAt !== null;
}

// 許可が外れていないことも見る: 「宣言はあるが未許可」の行は通常生まれないが、その不変条件が崩れた日に資格の側が緩まないようにするため
export function isDeclaredOwner(account: AuthAccount): boolean {
  return isAccountGranted(account) && account.ownerDeclaredAt !== null;
}

// 判定できない期限は使えない側に倒す: `expiresAt` が解釈できないと `Date.parse` が `NaN` を返し、`NaN <= now` は `false` で素通りするため。比べる向きも「期限より前なら開く」にする
export function isAccessTokenUsable(token: AccessTokenRecord, now: Date): boolean {
  if (token.revokedAt !== null) return false;
  if (token.expiresAt === null) return true;
  const expiresAt = Date.parse(token.expiresAt);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt > now.getTime();
}

export function isLoginRequestOpen(request: LoginRequest, now: Date): boolean {
  return Date.parse(request.expiresAt) > now.getTime();
}

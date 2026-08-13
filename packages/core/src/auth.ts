import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

/**
 * ログイン（誰が API を叩いているか）と、その人が alteroid を使ってよいかの2値。
 *
 * **これは PRD「権限境界」とは別の話である。** あちらは「クローンが何を人間に
 * 確認するか」を記憶で決める話で、行為の一覧を持ってはいけない。こちらは
 * 「そもそも誰がこの API に触れるか」であり、north_star 禁止2 が制限の表現方法
 * として**認めている実行環境の境界**（認証情報の配布範囲）そのものである。
 * 混ぜると、能力を削る仕組みを「認証」の名前で持ち込むことになる。
 *
 * したがってここに持つのは**許可されているか否かの2値だけ**で、
 * 「chat は可・記憶の編集は不可」のような行為別のスコープは持たない。
 *
 * マルチユーザーではない（PRD 非ゴール）。持ち主が複数の端末・複数のログイン手段
 * から入ってこられるようにするための層であって、利用者ごとにデータを分けない。
 */

const isoDateTime = z.string().datetime({ offset: true });

/** プロバイダ識別子（`google` / 将来 `discord` / `password`）。 */
export const authProviderIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

/**
 * ログインした人。**外部 identity とは別の層に置く。**
 *
 * 分けておかないと、後からパスワード認証を足すときに「パスワードは外部
 * identity ではないのに identity 表に入る」というねじれが出る。また Google と
 * Discord の両方で入ったときに同一人物へ束ねられなくなる。
 */
export const authAccountSchema = z.object({
  id: z.string().min(1),
  /** 表示用の名前。初回のログイン時にプロバイダから貰ったものを入れる。 */
  displayName: z.string().nullable(),
  /**
   * 本人が選んだ連絡先。**プロバイダ側の変更で勝手に上書きしない。**
   * ここに入っているメールは検証済みであることを不変条件とする（未検証のものは
   * identity 側にだけ置く）。
   */
  email: z.string().nullable(),
  createdAt: isoDateTime,
  lastLoginAt: isoDateTime.nullable(),
  /**
   * 許可の2値。`null` なら未許可＝ログインはできるが alteroid は使えない。
   * 付与は CLI（`alteroid access grant`）から行う。
   */
  grantedAt: isoDateTime.nullable(),
  /** 誰が許可したか（`operator` = 状態ファイルを読める実行環境の持ち主）。 */
  grantedBy: z.string().nullable(),
});

/**
 * 外部プロバイダ上の identity。`(provider, subject)` が一意。
 *
 * `email` はプロバイダが言っているメールで、ログインのたびに同期してよい
 * （本人が選んだ連絡先ではないため）。
 */
export const authIdentitySchema = z.object({
  provider: authProviderIdSchema,
  /** プロバイダ側の一意な id（Google なら `sub`）。メールではない。 */
  subject: z.string().min(1),
  accountId: z.string().min(1),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  createdAt: isoDateTime,
  lastLoginAt: isoDateTime,
});

/**
 * 発行済みアクセストークン。**素の値は保存しない**（sha256 だけ持つ）。
 *
 * 記憶へ到達できる鍵なので、漏れた保管先から復元できてはいけない。
 * `GET /auth/tokens` も素の値は返さない（`credentials.ts` の指紋と同じ考え方）。
 */
export const accessTokenRecordSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  sha256: z.string().length(64),
  /** どの端末で発行したか、人間が見分けるための覚書。 */
  label: z.string(),
  createdAt: isoDateTime,
  expiresAt: isoDateTime.nullable(),
  lastUsedAt: isoDateTime.nullable(),
  revokedAt: isoDateTime.nullable(),
});

/**
 * 進行中のログイン試行。CLI とブラウザの往復を繋ぐ。
 *
 * `state` を HMAC で署名する代わりに、この行そのものを突き合わせに使う
 * （サーバ側に置き場があるので署名鍵を増やす必要が無い）。
 */
export const loginRequestSchema = z.object({
  id: z.string().min(1),
  provider: authProviderIdSchema,
  /** state の後半。突き合わせは timing-safe に行う。 */
  nonce: z.string().min(1),
  /** PKCE の code_verifier。 */
  codeVerifier: z.string().min(1),
  /** CLI が引き取り時に提示する秘密の sha256。素の値は CLI だけが持つ。 */
  claimSha256: z.string().length(64),
  /** token 交換時にも同じ値を送る必要がある（プロバイダ側の突き合わせ）。 */
  redirectUri: z.string().min(1),
  label: z.string(),
  createdAt: isoDateTime,
  expiresAt: isoDateTime,
  status: z.enum(['pending', 'authenticated', 'consumed', 'failed']),
  accountId: z.string().nullable(),
  /** 失敗した理由（ブラウザではなく端末側に見せる）。 */
  error: z.string().nullable(),
});

export type AuthAccount = z.infer<typeof authAccountSchema>;
export type AuthIdentity = z.infer<typeof authIdentitySchema>;
export type AccessTokenRecord = z.infer<typeof accessTokenRecordSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginRequestStatus = LoginRequest['status'];

/**
 * ログインとアクセス許可の置き場。fs / pg のどちらのドライバでも同じ IF を満たす
 * （器が違うだけで上の層が見るものは同じ）。
 */
export interface AuthStore {
  listAccounts(): Promise<AuthAccount[]>;
  getAccount(id: string): Promise<AuthAccount | null>;
  /** 検証済みメールの衝突検査に使う。 */
  findAccountByEmail(email: string): Promise<AuthAccount | null>;
  putAccount(account: AuthAccount): Promise<void>;

  findIdentity(provider: string, subject: string): Promise<AuthIdentity | null>;
  listIdentities(accountId: string): Promise<AuthIdentity[]>;
  putIdentity(identity: AuthIdentity): Promise<void>;

  putAccessToken(token: AccessTokenRecord): Promise<void>;
  findAccessTokenBySha256(sha256: string): Promise<AccessTokenRecord | null>;
  listAccessTokens(accountId: string): Promise<AccessTokenRecord[]>;

  putLoginRequest(request: LoginRequest): Promise<void>;
  getLoginRequest(id: string): Promise<LoginRequest | null>;
}

// ---------------------------------------------------------------------------
// 乱数・ハッシュ
// ---------------------------------------------------------------------------

/** URL に載る乱数。既定 32 バイト（256 bit）。 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 16進文字列どうしの定数時間比較。
 *
 * 長さが違うと `timingSafeEqual` が投げるので、先に長さを見てから比較する
 * （長さの違いは秘密ではない）。
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** 発行するアクセストークンの見た目（ログに出たとき何か分かるように接頭辞を付ける）。 */
export const ACCESS_TOKEN_PREFIX = 'alt_';

export function issueAccessTokenValue(): string {
  return `${ACCESS_TOKEN_PREFIX}${randomToken(32)}`;
}

/** PKCE（S256）。公開クライアント相当なので必ず付ける。 */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** `state` は `<ログイン要求 id>.<nonce>`。id で引いて nonce を定数時間で突き合わせる。 */
export function encodeState(requestId: string, nonce: string): string {
  return `${requestId}.${nonce}`;
}

export function decodeState(state: string): { requestId: string; nonce: string } | null {
  const separator = state.indexOf('.');
  if (separator <= 0 || separator === state.length - 1) return null;
  return { requestId: state.slice(0, separator), nonce: state.slice(separator + 1) };
}

// ---------------------------------------------------------------------------
// 判定（ストアを触らない純粋関数 — テストしやすさのために切ってある）
// ---------------------------------------------------------------------------

export function isAccountGranted(account: AuthAccount): boolean {
  return account.grantedAt !== null;
}

export function isAccessTokenUsable(token: AccessTokenRecord, now: Date): boolean {
  if (token.revokedAt !== null) return false;
  if (token.expiresAt !== null && Date.parse(token.expiresAt) <= now.getTime()) return false;
  return true;
}

export function isLoginRequestOpen(request: LoginRequest, now: Date): boolean {
  return Date.parse(request.expiresAt) > now.getTime();
}

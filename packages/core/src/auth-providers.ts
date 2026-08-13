/**
 * ログイン手段の抽象。**プロバイダを1つ足すのが1ファイルで済む形にしてある。**
 *
 * 上の層（デーモンの経路・ストア・許可の2値）はこの IF しか見ない。Google に
 * 固有の事情（ID トークン・userinfo・スコープ名）はここから外へ漏らさない。
 *
 * 将来の拡張の置き場:
 * - **Discord OAuth** — `kind: 'oauth2'` のまま、このファイルと同じ形で1つ足す。
 *   認可 URL とトークン交換の宛先が違うだけで、上の層は変わらない。
 * - **メール + パスワード** — `kind: 'password'` として別の口を足す。
 *   **`oauth2` の枠に押し込まない**（パスワードは「外部の identity」ではなく
 *   「本人が持つ資格情報」で、概念が違う）。`AuthProvider` を判別可能ユニオンに
 *   してあるのはこのためで、パスワード用の経路が oauth 形の引数を要求されない。
 */

export interface OAuthProfile {
  /** プロバイダ側の一意な id。**メールを使わない**（メールは変わるため）。 */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

export interface AuthorizationRequest {
  state: string;
  /** PKCE（S256）のチャレンジ。 */
  codeChallenge: string;
  redirectUri: string;
}

export interface ExchangeRequest {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/** OAuth2 / OIDC で外部の identity を引き受けるプロバイダ。 */
export interface OAuthProvider {
  readonly kind: 'oauth2';
  readonly id: string;
  readonly label: string;
  authorizationUrl(request: AuthorizationRequest): string;
  exchange(request: ExchangeRequest): Promise<OAuthProfile>;
}

/**
 * 将来のメール + パスワード用の枠。**まだ実装は無い。**
 * 型として先に置いてあるのは、`AuthProvider` を判別可能ユニオンに保つため
 * （足すときに oauth 側の経路を書き換えずに済む）。
 */
export interface PasswordProvider {
  readonly kind: 'password';
  readonly id: string;
  readonly label: string;
}

export type AuthProvider = OAuthProvider | PasswordProvider;

export interface AuthProviderRegistry {
  list(): AuthProvider[];
  get(id: string): AuthProvider | null;
  /** oauth2 のものだけを引く（oauth 用の経路が誤って password を掴まないように）。 */
  oauth(id: string): OAuthProvider | null;
}

export function createAuthProviderRegistry(providers: AuthProvider[]): AuthProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id) ?? null,
    oauth: (id) => {
      const provider = byId.get(id);
      return provider !== undefined && provider.kind === 'oauth2' ? provider : null;
    },
  };
}

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  /** テストで差し替える（実ネットワークを叩かずに交換を確かめる）。 */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_SCOPES = 'openid email profile';

export const GOOGLE_PROVIDER_ID = 'google';

/**
 * Google OAuth 2.0（認可コード + PKCE）。
 *
 * **ID トークンの署名検証をしない代わりに userinfo を引いている。** 認可コードを
 * 交換したのは我々自身で、応答は TLS で Google のトークン端点から直接来ている。
 * この経路（authorization code flow）では OIDC も署名検証を省いてよいとしており、
 * JWKS の取得・鍵の回転・時計ずれを持ち込まずに済む。実装が減る分だけ壊れにくい。
 * 暗黙フロー（トークンがブラウザ経由で来る）なら話は別だが、それは使っていない。
 */
export function createGoogleProvider(config: OAuthProviderConfig): OAuthProvider {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    kind: 'oauth2',
    id: GOOGLE_PROVIDER_ID,
    label: 'Google',

    authorizationUrl(request) {
      const url = new URL(GOOGLE_AUTHORIZE_URL);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', request.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', GOOGLE_SCOPES);
      url.searchParams.set('state', request.state);
      url.searchParams.set('code_challenge', request.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      // リフレッシュトークンは受け取らない。Google 側の権限は本人確認にしか
      // 使っておらず、預かる理由が無い（預かれば漏れうる鍵が1本増える）。
      url.searchParams.set('access_type', 'online');
      // 常にアカウントを選ばせる。持ち主が複数アカウントを持っているとき、
      // 意図しない方で入って「許可されていない」と言われるのが分かりにくい。
      url.searchParams.set('prompt', 'select_account');
      return url.toString();
    },

    async exchange(request) {
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: request.code,
        code_verifier: request.codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: request.redirectUri,
      });

      const tokenResponse = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!tokenResponse.ok) {
        throw new Error(`Google のトークン交換が失敗した (${tokenResponse.status})`);
      }
      const tokens = (await tokenResponse.json()) as { access_token?: unknown };
      if (typeof tokens.access_token !== 'string') {
        throw new Error('Google のトークン応答に access_token が無い');
      }

      const userinfoResponse = await fetchImpl(GOOGLE_USERINFO_URL, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      if (!userinfoResponse.ok) {
        throw new Error(`Google の userinfo が引けなかった (${userinfoResponse.status})`);
      }
      const profile = (await userinfoResponse.json()) as {
        sub?: unknown;
        email?: unknown;
        email_verified?: unknown;
        name?: unknown;
      };
      if (typeof profile.sub !== 'string' || profile.sub.length === 0) {
        throw new Error('Google の userinfo に sub が無い');
      }

      return {
        subject: profile.sub,
        email: typeof profile.email === 'string' ? profile.email : null,
        emailVerified: profile.email_verified === true,
        displayName: typeof profile.name === 'string' ? profile.name : null,
      };
    },
  };
}

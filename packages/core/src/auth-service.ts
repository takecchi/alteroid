import {
  ACCESS_TOKEN_PREFIX,
  createPkcePair,
  decodeState,
  encodeState,
  isAccessTokenUsable,
  isLoginRequestOpen,
  issueAccessTokenValue,
  randomToken,
  sha256Hex,
  timingSafeEqualHex,
  type AccessTokenRecord,
  type AuthAccount,
  type AuthStore,
  type LoginRequest,
} from './auth.js';
import type { AuthProviderRegistry } from './auth-providers.js';

/**
 * ログインの手続きそのもの。**ストアと HTTP の間に置く。**
 *
 * ここに置いてあるのは器（fs / pg）に依らない判断だけなので、両方のドライバで
 * 同じ振る舞いが保証される。HTTP 経路（apps/daemon）はこの結果を状態コードに
 * 写すだけにしてある。
 */

export interface AuthServiceOptions {
  store: AuthStore;
  providers: AuthProviderRegistry;
  now?: () => Date;
  newId?: () => string;
  /** ログイン要求の寿命（秒）。ブラウザ往復に必要な分だけ開ける。 */
  loginTtlSeconds?: number;
  /** 発行するアクセストークンの寿命（日）。`null` で無期限。 */
  tokenTtlDays?: number | null;
}

export interface StartLoginInput {
  provider: string;
  redirectUri: string;
  label?: string;
}

export interface StartLoginResult {
  requestId: string;
  authorizationUrl: string;
  /** CLI だけが持つ引き取り用の秘密（ストアには sha256 しか残らない）。 */
  claimSecret: string;
  expiresAt: string;
}

export type CompleteLoginResult =
  | { status: 'ok'; accountId: string; granted: boolean }
  | { status: 'error'; reason: CompleteLoginError };

export type CompleteLoginError =
  'invalid_state' | 'expired' | 'already_used' | 'unknown_provider' | 'exchange_failed';

export type ClaimResult =
  | { status: 'pending' }
  | { status: 'ready'; token: string; account: AuthAccount }
  | { status: 'error'; reason: 'invalid_request' | 'invalid_secret' | 'expired' | 'failed' };

/**
 * 許可の付与の結果。
 *
 * `conflict` は「既に別のアカウントが許可されている」。**alteroid は単一の持ち主の
 * ものなので、許可されたアカウントは高々1つしか存在しない**（PRD 非ゴール:
 * マルチユーザー / チーム利用）。持ち主を移すときは先に `revoke` する。
 */
export type GrantResult =
  | { status: 'granted'; account: AuthAccount }
  | { status: 'not_found' }
  | { status: 'conflict'; owner: AuthAccount };

export interface AuthService {
  startLogin(input: StartLoginInput): Promise<StartLoginResult>;
  completeLogin(input: { state: string; code: string }): Promise<CompleteLoginResult>;
  claim(input: { requestId: string; claimSecret: string }): Promise<ClaimResult>;
  /** `Authorization: Bearer ...` の値からアカウントを引く。許可の判定はしない。 */
  authenticate(bearer: string): Promise<AuthAccount | null>;
  grant(accountId: string, by: string): Promise<GrantResult>;
  revoke(accountId: string): Promise<AuthAccount | null>;
  listAccounts(): Promise<AuthAccount[]>;
  /** いま alteroid を使える唯一のアカウント（居なければ `null`）。 */
  owner(): Promise<AuthAccount | null>;
}

const DEFAULT_LOGIN_TTL_SECONDS = 600;
const DEFAULT_TOKEN_TTL_DAYS = 30;
/** `lastUsedAt` の書き戻しはこの間隔まで間引く（毎リクエスト書くと器が痛む）。 */
const LAST_USED_THROTTLE_MS = 60_000;

export function createAuthService(options: AuthServiceOptions): AuthService {
  const { store, providers } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomToken(16));
  const loginTtlSeconds = options.loginTtlSeconds ?? DEFAULT_LOGIN_TTL_SECONDS;
  const tokenTtlDays =
    options.tokenTtlDays === undefined ? DEFAULT_TOKEN_TTL_DAYS : options.tokenTtlDays;

  async function fail(request: LoginRequest, reason: CompleteLoginError): Promise<void> {
    await store.putLoginRequest({ ...request, status: 'failed', error: reason });
  }

  return {
    async startLogin(input) {
      const provider = providers.oauth(input.provider);
      if (provider === null) throw new Error(`未知のログイン手段: ${input.provider}`);

      const at = now();
      const { verifier, challenge } = createPkcePair();
      const claimSecret = randomToken(32);
      const requestId = newId();
      const nonce = randomToken(16);
      const expiresAt = new Date(at.getTime() + loginTtlSeconds * 1000).toISOString();

      await store.putLoginRequest({
        id: requestId,
        provider: provider.id,
        nonce,
        codeVerifier: verifier,
        claimSha256: sha256Hex(claimSecret),
        redirectUri: input.redirectUri,
        label: input.label ?? '',
        createdAt: at.toISOString(),
        expiresAt,
        status: 'pending',
        accountId: null,
        error: null,
      });

      return {
        requestId,
        claimSecret,
        expiresAt,
        authorizationUrl: provider.authorizationUrl({
          state: encodeState(requestId, nonce),
          codeChallenge: challenge,
          redirectUri: input.redirectUri,
        }),
      };
    },

    async completeLogin({ state, code }) {
      const decoded = decodeState(state);
      if (decoded === null) return { status: 'error', reason: 'invalid_state' };

      const request = await store.getLoginRequest(decoded.requestId);
      if (request === null) return { status: 'error', reason: 'invalid_state' };
      // nonce の突き合わせは定数時間で。state はブラウザ経由で外から来る値である。
      if (!timingSafeEqualHex(sha256Hex(decoded.nonce), sha256Hex(request.nonce))) {
        return { status: 'error', reason: 'invalid_state' };
      }
      if (request.status !== 'pending') return { status: 'error', reason: 'already_used' };
      if (!isLoginRequestOpen(request, now())) {
        await fail(request, 'expired');
        return { status: 'error', reason: 'expired' };
      }

      const provider = providers.oauth(request.provider);
      if (provider === null) {
        await fail(request, 'unknown_provider');
        return { status: 'error', reason: 'unknown_provider' };
      }

      let profile;
      try {
        profile = await provider.exchange({
          code,
          codeVerifier: request.codeVerifier,
          redirectUri: request.redirectUri,
        });
      } catch {
        await fail(request, 'exchange_failed');
        return { status: 'error', reason: 'exchange_failed' };
      }

      const at = now().toISOString();
      const existing = await store.findIdentity(provider.id, profile.subject);

      let account: AuthAccount;
      if (existing !== null) {
        const found = await store.getAccount(existing.accountId);
        if (found === null) {
          await fail(request, 'exchange_failed');
          return { status: 'error', reason: 'exchange_failed' };
        }
        account = { ...found, lastLoginAt: at };
        await store.putAccount(account);
        // プロバイダ側のメールだけ追従する。**account.email は触らない**
        // （本人が選んだ連絡先を、プロバイダ側の変更で書き換えない）。
        await store.putIdentity({
          ...existing,
          email: profile.email,
          emailVerified: profile.emailVerified,
          lastLoginAt: at,
        });
      } else {
        /**
         * 初めて見る identity。**メールが一致しても既存アカウントへ相乗りさせない。**
         *
         * 別プロバイダで同じメールを名乗れる以上、メール一致での自動結合は
         * 「他人のメールでアカウントを作れば持ち主になれる」経路になる。
         * ここでは必ず別アカウントとして作り、許可は人間が CLI で明示的に与える。
         * 結合（同一人物の複数ログイン手段を束ねる）は identity 側に accountId が
         * あるので後から足せる。
         */
        const collision =
          profile.email !== null && profile.emailVerified
            ? await store.findAccountByEmail(profile.email)
            : null;

        account = {
          id: newId(),
          displayName: profile.displayName,
          // 衝突するときは連絡先を空にしておく（検証済みメールの一意性を壊さない）。
          email: collision === null && profile.emailVerified ? profile.email : null,
          createdAt: at,
          lastLoginAt: at,
          grantedAt: null,
          grantedBy: null,
        };
        await store.putAccount(account);
        await store.putIdentity({
          provider: provider.id,
          subject: profile.subject,
          accountId: account.id,
          email: profile.email,
          emailVerified: profile.emailVerified,
          createdAt: at,
          lastLoginAt: at,
        });
      }

      await store.putLoginRequest({
        ...request,
        status: 'authenticated',
        accountId: account.id,
      });

      return { status: 'ok', accountId: account.id, granted: account.grantedAt !== null };
    },

    async claim({ requestId, claimSecret }) {
      const request = await store.getLoginRequest(requestId);
      if (request === null) return { status: 'error', reason: 'invalid_request' };
      if (!timingSafeEqualHex(sha256Hex(claimSecret), request.claimSha256)) {
        return { status: 'error', reason: 'invalid_secret' };
      }
      if (request.status === 'failed') return { status: 'error', reason: 'failed' };
      // 一度きり。二度目は盗まれた可能性があるので、素直に無効として扱う。
      if (request.status === 'consumed') return { status: 'error', reason: 'invalid_request' };
      if (request.status === 'pending') {
        if (!isLoginRequestOpen(request, now())) return { status: 'error', reason: 'expired' };
        return { status: 'pending' };
      }

      /**
       * **ここで原子的に確保する。** 上の `status` 検査は早期の門前払いでしかなく、
       * 検査とトークン発行の間に別の claim が割り込める。同じ `requestId` と
       * `claimSecret` を並行に投げれば両方が `authenticated` を読めてしまうので、
       * 「1回きり」の強制はストアの1操作に置く。
       */
      const consumed = await store.consumeLoginRequest(requestId);
      if (consumed === null) return { status: 'error', reason: 'invalid_request' };

      const accountId = consumed.accountId;
      if (accountId === null) return { status: 'error', reason: 'failed' };
      const account = await store.getAccount(accountId);
      if (account === null) return { status: 'error', reason: 'failed' };

      const at = now();
      const value = issueAccessTokenValue();
      await store.putAccessToken({
        id: newId(),
        accountId: account.id,
        sha256: sha256Hex(value),
        label: consumed.label,
        createdAt: at.toISOString(),
        expiresAt:
          tokenTtlDays === null
            ? null
            : new Date(at.getTime() + tokenTtlDays * 86_400_000).toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      });

      return { status: 'ready', token: value, account };
    },

    async authenticate(bearer) {
      if (!bearer.startsWith(ACCESS_TOKEN_PREFIX)) return null;
      const record = await store.findAccessTokenBySha256(sha256Hex(bearer));
      if (record === null) return null;
      const at = now();
      if (!isAccessTokenUsable(record, at)) return null;

      const account = await store.getAccount(record.accountId);
      if (account === null) return null;

      await touch(store, record, at);
      return account;
    },

    async grant(accountId, by) {
      const account = await store.getAccount(accountId);
      if (account === null) return { status: 'not_found' };
      if (account.grantedAt !== null) return { status: 'granted', account };

      /**
       * **許可されたアカウントは高々1つ。**
       *
       * alteroid は単一の持ち主のものであり、マルチユーザー / チーム利用は
       * 非ゴールである（PRD「スコープ外」）。ここを開けると、ログインした人数だけ
       * 同じクローンの記憶・日誌・会話・実行 API が開く＝そのままマルチユーザーに
       * なる。「データを分けない」ことは「複数人を受け入れない」ことではない。
       *
       * 持ち主を移すときは先に revoke する（同一人物が別のログイン手段へ移る場合も
       * 同じ手順になる。identity を1つのアカウントへ束ねる仕組みは、必要になったら
       * accountId を付け替える形で足せる）。
       */
      const existing = await findOwner(store);
      if (existing !== null) return { status: 'conflict', owner: existing };

      const updated = { ...account, grantedAt: now().toISOString(), grantedBy: by };
      await store.putAccount(updated);
      return { status: 'granted', account: updated };
    },

    async revoke(accountId) {
      const account = await store.getAccount(accountId);
      if (account === null) return null;
      if (account.grantedAt === null) return account;
      const updated = { ...account, grantedAt: null, grantedBy: null };
      await store.putAccount(updated);
      return updated;
    },

    listAccounts: () => store.listAccounts(),
    owner: () => findOwner(store),
  };
}

/** 許可されているアカウント（不変条件として高々1つ）。 */
async function findOwner(store: AuthStore): Promise<AuthAccount | null> {
  const accounts = await store.listAccounts();
  return accounts.find((account) => account.grantedAt !== null) ?? null;
}

async function touch(store: AuthStore, record: AccessTokenRecord, at: Date): Promise<void> {
  const previous = record.lastUsedAt === null ? 0 : Date.parse(record.lastUsedAt);
  if (at.getTime() - previous < LAST_USED_THROTTLE_MS) return;
  await store.putAccessToken({ ...record, lastUsedAt: at.toISOString() });
}

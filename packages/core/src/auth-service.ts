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
  type GrantOutcome,
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
 * 許可の付与の結果（ストア側の `GrantOutcome` と同じもの）。
 * **再定義しない** — 分けた瞬間、片方だけ直して意味がずれる。
 */
export type GrantResult = GrantOutcome;

export interface AuthService {
  startLogin(input: StartLoginInput): Promise<StartLoginResult>;
  completeLogin(input: { state: string; code: string }): Promise<CompleteLoginResult>;
  claim(input: { requestId: string; claimSecret: string }): Promise<ClaimResult>;
  /** `Authorization: Bearer ...` の値からアカウントを引く。許可の判定はしない。 */
  authenticate(bearer: string): Promise<AuthAccount | null>;
  grant(accountId: string, by: string): Promise<GrantResult>;
  revoke(accountId: string): Promise<AuthAccount | null>;
  listAccounts(): Promise<AuthAccount[]>;
  /**
   * いま alteroid を使える全アカウント（誰も居なければ空）。
   *
   * ⚠️ **2026-09-09 のオーナー決定まで `owner(): Promise<AuthAccount | null>` だった。**
   * 上限を外した以上、単数の名前はここで嘘になる（1件しか返さない実装のままだと、
   * 2人目以降が呼び出し側から静かに消える）。
   */
  owners(): Promise<AuthAccount[]>;
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

      /**
       * **交換へ進む権利をここで取る。**
       *
       * 上の `pending` 検査は早期の門前払いでしかない。ブラウザの再送やプロキシの
       * リトライで同じ `state + code` が並行に届くのは普通に起きて、読んでから書く
       * 形だと両方が交換へ進む。認可コードは一度きりなので片方は必ず失敗し、その
       * 失敗が**古い写しから** `failed` を書けば、成功した側の `authenticated` を
       * 後から上書きしてログインを回収できなくする。
       *
       * 取れなかった側は「もう誰かが進んでいる」＝ `already_used` で降りる。
       */
      const claimedForExchange = await store.beginLoginExchange(decoded.requestId);
      if (claimedForExchange === null) return { status: 'error', reason: 'already_used' };

      const provider = providers.oauth(claimedForExchange.provider);
      if (provider === null) {
        await fail(claimedForExchange, 'unknown_provider');
        return { status: 'error', reason: 'unknown_provider' };
      }

      let profile;
      try {
        profile = await provider.exchange({
          code,
          codeVerifier: claimedForExchange.codeVerifier,
          redirectUri: claimedForExchange.redirectUri,
        });
      } catch {
        await fail(claimedForExchange, 'exchange_failed');
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
        ...claimedForExchange,
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
      // `processing` はプロバイダとの交換中。端末は待てばよい（`pending` と同じ扱い）。
      if (request.status === 'pending' || request.status === 'processing') {
        if (!isLoginRequestOpen(request, now())) return { status: 'error', reason: 'expired' };
        return { status: 'pending' };
      }

      const accountId = request.accountId;
      if (accountId === null) return { status: 'error', reason: 'failed' };
      const account = await store.getAccount(accountId);
      if (account === null) return { status: 'error', reason: 'failed' };

      const at = now();
      const value = issueAccessTokenValue();

      /**
       * **確保とトークンの保存を1操作で行う。**
       *
       * 上の `status` 検査は早期の門前払いでしかない。ここを「読む→検査→書く」に
       * 割ると同じ claim の並行送信で二重発行になり、「先に consumed にする→後で
       * 保存する」に割ると保存失敗でログインを回収できなくなる（トークンは返らない
       * のに要求は消費済み）。だから両方をストアの1操作へ渡す。
       */
      const claimed = await store.claimLoginRequest(requestId, (consumed) => ({
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
      }));
      if (claimed === null) return { status: 'error', reason: 'invalid_request' };

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
      /**
       * **許可できるアカウントの数に上限は無い**（2026-09-09 のオーナー決定）。
       *
       * ⚠️ **それ以前は高々1つで、2人目は `conflict` だった。** 外した理由と、
       * 「入口の数」と「利用者ごとにデータを分けること」の線は `AuthStore.grantAccess`
       * の doc が持つ（逐語は `grep -Fn -- '外したのは入口の数であって' packages/core/src/auth.ts`）。
       * **ここに書き写さないこと** — 2か所に置けば必ずずれる。
       *
       * **⚠️ この決定で、許可が伝播するようになった。** `/access/*` は 2026-09-06 から
       * 「許可されたアカウント」も実行環境の持ち主と同格に叩けるが、それまでは2人目が
       * 必ず 409 で弾かれていたので**伝播は起こりようがなかった。** いまは A が B を、
       * B が C を通せる。同格化そのものはオーナー決定なので戻さない — 代わりに
       * **誰が誰を通したかを日誌へ必ず残す**（`apps/daemon/src/app.ts` の grant 経路）。
       * `grantedBy` に固定値を書かないことが、ここで初めて意味を持つ。
       *
       * 上限が消えても**書き込みはストアの1操作のままにする** — 理由は他の行との
       * 不変条件ではなく、同じ account への同時 grant で `grantedBy` が上書きされると
       * 日誌と食い違うことである（同じく `grantAccess` の doc）。
       */
      return store.grantAccess(accountId, now().toISOString(), by);
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
    owners: () => findOwners(store),
  };
}

/** 許可されているアカウント（0件以上。上限は無い）。 */
async function findOwners(store: AuthStore): Promise<AuthAccount[]> {
  const accounts = await store.listAccounts();
  return accounts.filter((account) => account.grantedAt !== null);
}

async function touch(store: AuthStore, record: AccessTokenRecord, at: Date): Promise<void> {
  const previous = record.lastUsedAt === null ? 0 : Date.parse(record.lastUsedAt);
  if (at.getTime() - previous < LAST_USED_THROTTLE_MS) return;
  await store.putAccessToken({ ...record, lastUsedAt: at.toISOString() });
}

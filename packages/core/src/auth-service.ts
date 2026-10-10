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
import { reasonOf } from './dropped-record.js';
import { hasNul } from './nul-guard.js';
import type { RemoveUnreadableRowsOptions, RemoveUnreadableRowsResult } from './store.js';

export interface AuthServiceOptions {
  store: AuthStore;
  providers: AuthProviderRegistry;
  now?: () => Date;
  newId?: () => string;
  loginTtlSeconds?: number;
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

export type LogoutResult = { status: 'ok' } | { status: 'not_found' };

// 再定義しない: 分けると片方だけ直して意味がずれるため
export type GrantResult = GrantOutcome;

export interface AuthService {
  startLogin(input: StartLoginInput): Promise<StartLoginResult>;
  completeLogin(input: { state: string; code: string }): Promise<CompleteLoginResult>;
  claim(input: { requestId: string; claimSecret: string }): Promise<ClaimResult>;
  authenticate(bearer: string): Promise<AuthAccount | null>;
  // operator の token をここで弾かない: どの資格で認証されたか（`Principal`）を知っているのは HTTP 層だけで、`AuthService` はその型を知らないため
  logout(bearer: string): Promise<LogoutResult>;
  grant(accountId: string, by: string): Promise<GrantResult>;
  // 行は在るが読めない（fs の `invalidAccountsRaw`）ときは null にせず `UnreadableAccountError` を投げる
  revoke(accountId: string): Promise<AuthAccount | null>;
  removeUnreadableAccounts(
    ids: readonly string[],
    options?: RemoveUnreadableRowsOptions,
  ): Promise<RemoveUnreadableRowsResult>;
  listAccounts(): Promise<AuthAccount[]>;
  grantedAccounts(): Promise<AuthAccount[]>;
}

const DEFAULT_LOGIN_TTL_SECONDS = 600;
const DEFAULT_TOKEN_TTL_DAYS = 30;
// `lastUsedAt` の書き戻しはこの間隔まで間引く: 毎リクエスト書くと器が痛むため
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
      // nonce の突き合わせは定数時間で行う: state はブラウザ経由で外から来る値のため
      if (!timingSafeEqualHex(sha256Hex(decoded.nonce), sha256Hex(request.nonce))) {
        return { status: 'error', reason: 'invalid_state' };
      }
      if (request.status !== 'pending') return { status: 'error', reason: 'already_used' };
      if (!isLoginRequestOpen(request, now())) {
        await fail(request, 'expired');
        return { status: 'error', reason: 'expired' };
      }

      // 読んでから書く形にしない: 同じ `state + code` が並行に届くと両方が交換へ進み、失敗した側が古い写しから `failed` を書いて成功側の `authenticated` を上書きするため
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

      // NUL を含む subject は交換の失敗として降りる: ストアが書き込みで断る（`NulNotAllowedError`）ため。要求を `processing` のまま残さない
      if (hasNul(profile.subject)) {
        await fail(claimedForExchange, 'exchange_failed');
        return { status: 'error', reason: 'exchange_failed' };
      }
      // NUL を含むメールは閉じる側（ログイン失敗）に倒す: ストアが断るため。stderr には欄名と固定の文だけを残し、メールの値は載せない
      if (profile.emailVerified && profile.email !== null && hasNul(profile.email)) {
        process.stderr.write(
          'alteroid: ログインを断った（auth.email に NUL を含むので断った。プロバイダが返した検証済みメール）\n',
        );
        await fail(claimedForExchange, 'exchange_failed');
        return { status: 'error', reason: 'exchange_failed' };
      }

      // 例外を `completeLogin` の外へ抜けさせない: 抜けると要求が `processing` のまま残り、端末の `claim` が TTL まで `pending` を受け取り続けるため
      try {
        const at = now().toISOString();
        const existing = await store.findIdentity(provider.id, profile.subject);

        let account: AuthAccount;
        if (existing !== null) {
          const found = await store.getAccount(existing.accountId);
          if (found === null) {
            await fail(claimedForExchange, 'exchange_failed');
            return { status: 'error', reason: 'exchange_failed' };
          }
          account = await touchAccountLogin(store, found, at);
          // account.email は触らない: 本人が選んだ連絡先を、プロバイダ側の変更で書き換えないため
          await store.putIdentity({
            ...existing,
            email: profile.email,
            emailVerified: profile.emailVerified,
            lastLoginAt: at,
          });
        } else {
          // メールが一致しても既存アカウントへ相乗りさせない: 別プロバイダで同じメールを名乗れる以上、自動結合は「他人のメールでアカウントを作れば持ち主になれる」経路になるため
          // メールの衝突検査をここで行わない: 別々の identity が同時に初回ログインすると両方が「衝突なし」を見るため、`createAccountWithIdentity` の1操作に委ねる
          const candidateAccount: AuthAccount = {
            id: newId(),
            displayName: profile.displayName,
            email: profile.emailVerified ? profile.email : null,
            createdAt: at,
            lastLoginAt: at,
            grantedAt: null,
            grantedBy: null,
          };

          // 「読む→検査→書く」に割らない: 同じ `(provider, subject)` の同時ログインで別々の account ができるため。渡した `candidateAccount` ではなくこの結果だけを信じる
          const outcome = await store.createAccountWithIdentity({
            account: candidateAccount,
            identity: {
              provider: provider.id,
              subject: profile.subject,
              accountId: candidateAccount.id,
              email: profile.email,
              emailVerified: profile.emailVerified,
              createdAt: at,
              lastLoginAt: at,
            },
          });

          if (outcome.created) {
            account = outcome.account;
          } else {
            const found = await store.getAccount(outcome.existing.accountId);
            if (found === null) {
              await fail(claimedForExchange, 'exchange_failed');
              return { status: 'error', reason: 'exchange_failed' };
            }
            account = await touchAccountLogin(store, found, at);
            await store.putIdentity({
              ...outcome.existing,
              email: profile.email,
              emailVerified: profile.emailVerified,
              lastLoginAt: at,
            });
          }
        }

        await store.putLoginRequest({
          ...claimedForExchange,
          status: 'authenticated',
          accountId: account.id,
        });

        return { status: 'ok', accountId: account.id, granted: account.grantedAt !== null };
      } catch (error) {
        // 握りつぶさず stderr に1行出す: 後始末（`failed` への書き込み）も同じ器に頼るため
        process.stderr.write(
          `alteroid: ログインの交換の後の器の操作が失敗した。要求を failed に落とす: ${reasonOf(error)}\n`,
        );
        try {
          await fail(claimedForExchange, 'exchange_failed');
        } catch (failError) {
          process.stderr.write(
            `alteroid: ログイン要求を failed に落とせなかった。要求は processing のまま残る: ${reasonOf(failError)}\n`,
          );
        }
        return { status: 'error', reason: 'exchange_failed' };
      }
    },

    async claim({ requestId, claimSecret }) {
      const request = await store.getLoginRequest(requestId);
      if (request === null) return { status: 'error', reason: 'invalid_request' };
      if (!timingSafeEqualHex(sha256Hex(claimSecret), request.claimSha256)) {
        return { status: 'error', reason: 'invalid_secret' };
      }
      if (request.status === 'failed') return { status: 'error', reason: 'failed' };
      // 二度目は盗まれた可能性があるので、無効として扱う
      if (request.status === 'consumed') return { status: 'error', reason: 'invalid_request' };
      if (request.status === 'pending' || request.status === 'processing') {
        if (!isLoginRequestOpen(request, now())) return { status: 'error', reason: 'expired' };
        return { status: 'pending' };
      }

      // 期限切れでも `failed` へ書き換えない: 書き込みは前進のときだけに絞る。読むだけの経路に足すと書く理由が「不変条件の保存」から「観測のついで」へ広がるため
      if (!isLoginRequestOpen(request, now())) return { status: 'error', reason: 'expired' };

      const accountId = request.accountId;
      if (accountId === null) return { status: 'error', reason: 'failed' };
      const account = await store.getAccount(accountId);
      if (account === null) return { status: 'error', reason: 'failed' };

      const at = now();
      const value = issueAccessTokenValue();

      // 確保とトークンの保存を1操作にする: 「読む→検査→書く」に割ると並行送信で二重発行になり、「先に consumed にする→後で保存する」に割ると保存失敗でログインを回収できなくなるため
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

    async logout(bearer) {
      const record = await store.findAccessTokenBySha256(sha256Hex(bearer));
      if (record === null) return { status: 'not_found' };
      // 二重ログアウトを特別扱いしない: `revoked` / `already_revoked` はどちらも「もう使えない」という同じ事実のため
      const outcome = await store.revokeAccessToken(record.id, now().toISOString());
      return outcome.status === 'not_found' ? { status: 'not_found' } : { status: 'ok' };
    },

    async grant(accountId, by) {
      // 書き込みはストアの1操作のままにする: 同じ account への同時 grant で `grantedBy` が上書きされると日誌と食い違うため
      return store.grantAccess(accountId, now().toISOString(), by);
    },

    async revoke(accountId) {
      const account = await store.getAccount(accountId);
      if (account === null) {
        // 「無い」と言い切る前に `revokeAccountAccess` を1回呼ぶ: `getAccount` の `null` は読めない行も含み、その行は `UnreadableAccountError` で言い分ける。`getAccount` 自体は投げない: 認証の経路が 401 でなく 500 になるため
        await store.revokeAccountAccess(accountId);
        return null;
      }
      if (account.grantedAt === null) return account;
      // 行を丸ごと書き戻さない: 読んでから書くまでに完了した再ログインの `lastLoginAt` を古い写しで上書きするため。戻り値は書き込み後に読み直す
      await store.revokeAccountAccess(accountId);
      return (
        (await store.getAccount(accountId)) ?? {
          ...account,
          grantedAt: null,
          grantedBy: null,
        }
      );
    },

    removeUnreadableAccounts: (ids, options) => store.removeUnreadableAccounts(ids, options),

    listAccounts: () => store.listAccounts(),
    grantedAccounts: () => findGrantedAccounts(store),
  };
}

async function findGrantedAccounts(store: AuthStore): Promise<AuthAccount[]> {
  const accounts = await store.listAccounts();
  return accounts.filter((account) => account.grantedAt !== null);
}

// 行を丸ごと書き戻さない: 読んでから書くまでに完了した access grant / revoke を古い写しで上書きするため。戻り値の `account` は書き込み後に読み直す
async function touchAccountLogin(
  store: AuthStore,
  found: AuthAccount,
  at: string,
): Promise<AuthAccount> {
  await store.markAccountLoggedIn(found.id, at);
  return (await store.getAccount(found.id)) ?? { ...found, lastLoginAt: at };
}

async function touch(store: AuthStore, record: AccessTokenRecord, at: Date): Promise<void> {
  const previous = record.lastUsedAt === null ? 0 : Date.parse(record.lastUsedAt);
  if (at.getTime() - previous < LAST_USED_THROTTLE_MS) return;
  // 行を丸ごと書き戻さない: 読んだ写し（`record`）を `putAccessToken` で書くと、そのあいだに完了したログアウトの `revokedAt` を `null` に戻すため
  await store.markAccessTokenUsed(record.id, at.toISOString());
}

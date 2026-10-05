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
  type OwnerOutcome,
} from './auth.js';
import type { AuthProviderRegistry } from './auth-providers.js';
import { hasNul } from './nul-guard.js';
import type { RemoveUnreadableRowsOptions, RemoveUnreadableRowsResult } from './store.js';

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
 * `logout` の結果（issue #1757）。
 *
 * - `ok` — いま提示されている、このトークンを失効させた（既に失効済みだった
 *   場合を含む——`AuthStore.revokeAccessToken` の `revoked` / `already_revoked`
 *   はどちらも呼び手からは「もう使えない」という同じ事実なので、ここでは
 *   1つに畳む。畳んだ理由は `logout` の doc にある）
 * - `not_found` — 提示された値に対応するアクセストークンの行が無い（通常は
 *   起こらない——`authenticate` を通って `Principal` を得た直後に呼ぶ経路
 *   でしか使わないため。防御的に残す）
 */
export type LogoutResult = { status: 'ok' } | { status: 'not_found' };

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
  /**
   * **いま提示されている、この1本のアクセストークンだけを失効させる**
   * （issue #1757、`alteroid logout` / Web のログアウトの実体）。
   *
   * `authenticate` と対になる——`authenticate` が bearer からアカウントを
   * 引くのと同じ経路（sha256 で `AuthStore.findAccessTokenBySha256` を引く）を
   * たどり、見つかった行の id だけを `AuthStore.revokeAccessToken` に渡す。
   * **同じアカウントの他のトークンには触らない。** アカウントごと締め出す
   * `revoke()` とは別の操作である（`revoke()` の doc）。
   *
   * **operator の資格（`ACCESS_TOKEN_PREFIX` を持たない状態ファイルの token）は
   * ここへは来ない。** ここは `bearer` の形（`alt_` 接頭辞）を見ないので、
   * operator の token を渡されても `findAccessTokenBySha256` が見つけられず
   * `not_found` になるだけである——**operator を弾く判断は呼び手（HTTP 層）の
   * 仕事**にしてある。理由は「どの資格で認証されたか」（`Principal`）を
   * 知っているのが HTTP 層（`apps/daemon/src/app.ts` の `authenticate`
   * ミドルウェア）だけで、`AuthService` はその型を知らない層だからである。
   */
  logout(bearer: string): Promise<LogoutResult>;
  grant(accountId: string, by: string): Promise<GrantResult>;
  /**
   * 無い id は `null`。**行は在るが読めない（fs の `invalidAccountsRaw`）ときは
   * `null` にせず `UnreadableAccountError` を投げる**（issue #2425。行は変えない）。
   */
  revoke(accountId: string): Promise<AuthAccount | null>;
  /**
   * 読めないアカウントの行を id で指して消す（issue #2440。`AuthStore.removeUnreadableAccounts`
   * の doc）。`revoke` は読めない行に触れないので、片付ける口はこれだけである。
   */
  removeUnreadableAccounts(
    ids: readonly string[],
    options?: RemoveUnreadableRowsOptions,
  ): Promise<RemoveUnreadableRowsResult>;
  /** 実行環境の持ち主として宣言する／取り消す（issue #1198）。operator トークンだけが呼ぶ。 */
  setOwner(accountId: string, declared: boolean): Promise<OwnerOutcome>;
  listAccounts(): Promise<AuthAccount[]>;
  /**
   * いま alteroid を使える全アカウント（誰も居なければ空）。
   *
   * ⚠️ **2026-09-09 のオーナー決定まで `owner(): Promise<AuthAccount | null>` だった。**
   * 上限を外した以上、単数の名前はここで嘘になる（1件しか返さない実装のままだと、
   * 2人目以降が呼び出し側から静かに消える）。
   *
   * ⚠️ **2026-09-18、`owners()` からここへ改名した**（issue #1198）。「owner」が
   * `ownerDeclaredAt`（実行環境の持ち主として宣言されたアカウント）と「許可された
   * 全アカウント」の2つの意味を持つと同じ語がずれる。ここが返すのは後者（許可の
   * 有無だけを見る）なので、意味に合わせて `grantedAccounts` へ改めた。呼び手は
   * 自分のテスト（`auth-service.test.ts`）だけなので改名は安全である。
   */
  grantedAccounts(): Promise<AuthAccount[]>;
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

      // プロバイダの返した subject は外から来る値で、identity の鍵になる。NUL を含むものは
      // ストアが書き込みで断る（`NulNotAllowedError`。#3011）ので、ここで交換の失敗として降りる
      // （400 の画面になる。401 とは別。要求を `processing` のまま残さない）。
      if (hasNul(profile.subject)) {
        await fail(claimedForExchange, 'exchange_failed');
        return { status: 'error', reason: 'exchange_failed' };
      }
      // 検証済みのメールは account.email に載り、一意の索引と衝突の検査に使われる。NUL を含むものは
      // ストアが断る（teto の判断、2026-10-06）ので、閉じる側（ログイン失敗）に倒す。
      // 断った理由は stderr に残す——欄名と固定の文だけで、メールの値は載せない。
      if (profile.emailVerified && profile.email !== null && hasNul(profile.email)) {
        process.stderr.write(
          'alteroid: ログインを断った（auth.email に NUL を含むので断った。プロバイダが返した検証済みメール）\n',
        );
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
        account = await touchAccountLogin(store, found, at);
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
         * 初めて見る identity（にこの時点では見える）。**メールが一致しても
         * 既存アカウントへ相乗りさせない。**
         *
         * 別プロバイダで同じメールを名乗れる以上、メール一致での自動結合は
         * 「他人のメールでアカウントを作れば持ち主になれる」経路になる。
         * ここでは必ず別アカウントとして作り、許可は人間が CLI で明示的に与える。
         * 結合（同一人物の複数ログイン手段を束ねる）は identity 側に accountId が
         * あるので後から足せる。
         *
         * **メールの衝突検査（大小文字違いの攻撃者を弾く）は
         * `createAccountWithIdentity` の1操作の中で行う（issue #1751 / #1741）。**
         * 直す前はここ（読んでから書く外側）に `findAccountByEmail` を置いていたが、
         * **別々の** identity が同じ検証済みメールで同時に初回ログインすると、
         * 両方がここで「衝突なし」を見てしまい、両方の候補にメールが乗った
         * （memory / fs は重複したアカウントができ、pg は一意索引の生の例外で
         * 片方が reject された）。だから衝突の有無は候補を渡すだけにして、
         * 判断そのものはストアの1操作の結果（`outcome.account`）に委ねる——
         * ここでは判断しない。
         */
        const candidateAccount: AuthAccount = {
          id: newId(),
          displayName: profile.displayName,
          email: profile.emailVerified ? profile.email : null,
          createdAt: at,
          lastLoginAt: at,
          grantedAt: null,
          grantedBy: null,
          ownerDeclaredAt: null,
        };

        /**
         * **account の作成・identity の作成・メールの衝突検査を1操作で行う**
         * （issue #1714 / #1751 / #1741）。
         *
         * 上の `findIdentity` は早期の門前払いでしかない。同じ
         * `(provider, subject)` の2つのログインが同時に着くと、両方がここまで
         * `null` を見て進む。「読む→検査→書く」に割ったままだと両方が別の
         * account を作ってしまうので、`putAccount` + `putIdentity` の対を
         * ストアの1操作へ渡し、在れば作らず既存を返させる。メールの衝突検査も
         * 同じ理由で同じ操作の中にある——**この結果だけを信じる**（渡した
         * `candidateAccount` をそのまま使わない）。
         */
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
          // 負けた側。既存 identity のログインと同じ扱いに落とす
          // （直上の `existing !== null` の分岐と同じ処理）。
          const found = await store.getAccount(outcome.existing.accountId);
          if (found === null) {
            await fail(request, 'exchange_failed');
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

      /**
       * ここに来るのは `status === 'authenticated'` だけ（`failed` / `consumed` /
       * `pending` / `processing` は上で全部返している）。
       *
       * **`expiresAt` はブラウザの往復が終わるまでの寿命ではなく、要求そのものの
       * 寿命である**（`AuthServiceOptions.loginTtlSeconds` の doc）。ブラウザが
       * TTL 内に戻ってきて `completeLogin` が `authenticated` にしたとしても、
       * その後 CLI 側の引き取りが TTL を過ぎているなら同じく無効として扱う——
       * ここだけ無期限に引き取れると、`expiresAt` を過ぎた `claimSecret` が
       * いつまでも使える鍵になってしまう。
       *
       * **`pending`/`processing` の期限切れと同じく、ここでも `failed` へは
       * 書き換えない。** ストアへの書き込みは「交換へ進む／トークンを発行する」
       * という前進のときだけに絞ってある——読むだけの経路（`claim` の期限切れ
       * 判定）にまで書き込みを足すと、書く理由が「不変条件の保存」から「観測の
       * ついで」へ広がってしまう。
       */
      if (!isLoginRequestOpen(request, now())) return { status: 'error', reason: 'expired' };

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

    async logout(bearer) {
      const record = await store.findAccessTokenBySha256(sha256Hex(bearer));
      if (record === null) return { status: 'not_found' };
      // `revokeAccessToken` は `revoked` / `already_revoked` を分けて返すが、
      // 呼び手（ログアウト）にとってはどちらも「もう使えない」という同じ
      // 事実である——二重ログアウトを特別扱いしない（`LogoutResult` の doc）。
      const outcome = await store.revokeAccessToken(record.id, now().toISOString());
      return outcome.status === 'not_found' ? { status: 'not_found' } : { status: 'ok' };
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
      if (account === null) {
        /**
         * **`getAccount` の `null` は「読めない行」も含む**（fs は `invalidAccountsRaw`
         * を返さない。issue #2425）。「無い」と言い切る前に `revokeAccountAccess` を
         * 1回呼ぶ——本当に無い id は何もせず（書かず）、読めない行なら
         * `UnreadableAccountError` を投げ、呼び手（HTTP 層）が「読めない形で在る」と
         * 言い分ける。`getAccount` 自体は投げない（認証の経路が 401 でなく 500 に
         * なるのを避ける）。
         */
        await store.revokeAccountAccess(accountId);
        return null;
      }
      /**
       * **許可の取り消しは、宣言済みの owner も落とす。**（issue #1198）
       *
       * 不変条件「宣言 ⟹ 許可済み」を保つのはストア側（`setAccountOwner`）だが、
       * ここは反対向き — 許可が消えるなら、それに乗っていた宣言も一緒に消える
       * 必要がある。**再 grant しても owner には戻らない** — 宣言は明示的な
       * 行為（`alteroid access owner <id>`）でしか立たない。
       */
      if (account.grantedAt === null) return account;
      /**
       * **行を丸ごと書き戻さない**（issue #1915）。`account`（`getAccount` で
       * 読んだときの写し）を `putAccount` に渡すと、読んでから書くまでの
       * あいだに完了した再ログイン（`markAccountLoggedIn`）の `lastLoginAt`
       * を、写しに残った古い値で上書きしてしまう（`touchAccountLogin` が
       * #1870 で塞いだのと同じ形の lost update）。`revokeAccountAccess` で
       * 3欄だけを落とし、戻り値は書き込み後に読み直して最新の状態を返す
       * ——`lastLoginAt` を巻き込まないことと、呼び手が見る戻り値が古い
       * スナップショットのままにならないことの両方を、これで保証する。
       */
      await store.revokeAccountAccess(accountId);
      return (
        (await store.getAccount(accountId)) ?? {
          ...account,
          grantedAt: null,
          grantedBy: null,
          ownerDeclaredAt: null,
        }
      );
    },

    removeUnreadableAccounts: (ids, options) => store.removeUnreadableAccounts(ids, options),

    setOwner: (accountId, declared) =>
      store.setAccountOwner(accountId, declared ? now().toISOString() : null),

    listAccounts: () => store.listAccounts(),
    grantedAccounts: () => findGrantedAccounts(store),
  };
}

/** 許可されているアカウント（0件以上。上限は無い）。 */
async function findGrantedAccounts(store: AuthStore): Promise<AuthAccount[]> {
  const accounts = await store.listAccounts();
  return accounts.filter((account) => account.grantedAt !== null);
}

/**
 * ログイン成功時の `lastLoginAt` の書き戻し（issue #1870）。**行を丸ごと
 * 書き戻さない** — `found`（`getAccount` で読んだときの写し）を
 * `putAccount` に渡すと、読んでから書くまでの間に完了した access grant /
 * access revoke / owner 宣言を、写しに残った古い値で上書きしてしまう
 * （`touch()` が #1782 で塞いだのと同じ形）。`markAccountLoggedIn` で
 * `lastLoginAt` だけを進め、`completeLogin` の戻り値（`granted`）に使う
 * `account` は書き込み後に読み直して最新の状態を返す——`grantedAt` を
 * 巻き込まないことと、呼び手が見る `granted` が古いスナップショットのまま
 * にならないことの両方を、この1関数で保証する。
 */
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
  // **行を丸ごと書き戻さない**（issue #1782）。読んだときの写し（`record`）を
  // `putAccessToken` で書き戻すと、そのあいだに完了したログアウトの
  // `revokedAt` を `null` に戻してしまう。`lastUsedAt` だけを書く1操作に渡す。
  await store.markAccessTokenUsed(record.id, at.toISOString());
}

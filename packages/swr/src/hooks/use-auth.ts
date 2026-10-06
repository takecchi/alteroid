/**
 * いまこの画面がデーモンに対して何者か。
 *
 * 状態は5つ。**「入れない」を1つに潰さない** — 原因ごとに人間がやることが違う。
 *
 * | 状態 | 意味 | 人間がやること |
 * |---|---|---|
 * | `checking` | 確認中 | 待つ |
 * | `open` | デーモンが認証を要求していない | 何も要らない（従来どおり） |
 * | `anonymous` | 未ログイン / 鍵が無効 | ログインする |
 * | `ungranted` | ログイン済みだが使う許可が無い | 人間が `alteroid access grant` |
 * | `ready` | 通る | — |
 *
 * `ungranted` を `anonymous` に混ぜてはいけない。混ぜるとログインし直す導線を
 * 出すことになり、**何度やっても解決しない**（許可は CLI からしか与えられない）。
 */
import useSWR from 'swr';

import { ApiError, expectOk, unwrap, useApiContext } from '../api';
import { redactError, type StoredAccount } from '@alteroid/logic';

/** `logout()` の結果。失敗のときは人間に見せてよい1行を持つ。 */
export type LogoutResult = { ok: true } | { ok: false; message: string };

export type AuthStatus = 'checking' | 'open' | 'anonymous' | 'ungranted' | 'ready';

export interface AuthProvider {
  id: string;
  label: string;
  kind: string;
}

export interface AuthState {
  status: Exclude<AuthStatus, 'checking'>;
  providers: AuthProvider[];
  /** ログイン済みなら、このデーモンでの自分。 */
  account: StoredAccount | null;
  /**
   * 実行環境の持ち主のトークンで通っている。
   *
   * **`/access` を叩けるかどうかとは、もう一致しない** — 2026-09-06 の同格化で、
   * 許可されたアカウントも `/access/*` と `/tokens` を叩ける。この旗が今も
   * 意味を持つのは `/profile` の2本だけである。
   */
  operator: boolean;
}

export function useAuth() {
  const { client, baseUrl, credential, setCredential, clearCredentialIfCurrent } = useApiContext();

  const query = useSWR<AuthState>(
    // 接続先と鍵が変われば見直す。
    { type: 'authState', baseUrl, token: credential?.token ?? null },
    async (): Promise<AuthState> => {
      // `/health` は認証を要求しない。ここで「そもそも認証が要るのか」が分かる。
      const health = await client.api.GET('/health').then(unwrap);
      const providers = health.auth.providers;

      if (!health.auth.enabled) {
        return { status: 'open', providers, account: null, operator: health.operator };
      }
      if (credential === null) {
        return { status: 'anonymous', providers, account: null, operator: false };
      }

      try {
        const me = await client.api.GET('/auth/me').then(unwrap);
        return {
          status: 'ready',
          providers,
          account: me.kind === 'account' ? me.account : null,
          operator: me.kind === 'operator',
        };
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) {
          // 門番が止めているので `/auth/me` の本文は来ない。引き取り時に控えた
          // アカウントを出す（`alteroid access grant <id>` の id がここにしか無い）。
          return {
            status: 'ungranted',
            providers,
            account: credential.account,
            operator: false,
          };
        }
        if (error instanceof ApiError && error.status === 401) {
          /**
           * **ここで捨てる。**
           *
           * 401 を「未ログインという正常な状態」として返しているので、
           * `ApiProvider` の共通ハンドラ（`SWRConfig.onError`）には届かない。
           * 認証を確かめる主要な経路だけが「401 なら鍵を捨てる」という約束から
           * 外れると、失効した秘密が保存先に残り続け、読み込み直すたびに同じ鍵を
           * 出しては 401 を貰うことになる。
           *
           * 捨てると鍵が変わるので、このキー自体が引き直される（`credential === null`
           * の枝に落ちて、`/auth/me` を叩かずに anonymous を返す）。
           *
           * **この応答が使った組を渡す。** 遅れて届いた 401 が、既に切り替えた先の
           * 有効な鍵を巻き添えにしないため（判定は `api.tsx` 側で行う）。
           */
          clearCredentialIfCurrent(baseUrl, credential.token);
          return { status: 'anonymous', providers, account: null, operator: false };
        }
        throw error;
      }
    },
    // 認証まわりは「繋がらない」と区別が付くよう、黙って再試行し続けない。
    { shouldRetryOnError: false },
  );

  const status: AuthStatus = query.data === undefined ? 'checking' : query.data.status;

  return {
    status,
    providers: query.data?.providers ?? [],
    account: query.data?.account ?? null,
    operator: query.data?.operator ?? false,
    error: query.error as unknown,
    isLoading: query.isLoading,
    /** 取り直しの最中（接続の失敗画面の「もう一度試す」が押せなくなる印）。 */
    isValidating: query.isValidating,
    revalidate: query.mutate,
    /**
     * ログアウト（issue #1757）。**先にサーバ側のトークンを失効させてから**
     * 鍵を捨てる——鍵だけ捨ててサーバ側を生かしたままにする元の欠陥（issue
     * 本文）を、CLI と同じ設計で塞ぐ。
     *
     * - 鍵が無ければ何もしない（失効させる対象が無い）
     * - 成功（2xx）／401（既に無効）→ 鍵を捨てて `{ ok: true }`
     * - それ以外（403・5xx・ネットワーク到達不能等）→ **鍵は捨てない** —
     *   捨てると、以後サーバ側を失効させる手段が無くなる（`alteroid access
     *   revoke` は端末からしか打てない）。呼び手は `{ ok: false, message }`
     *   を見て、その旨を出し、`discardCredential()`（鍵だけを捨てる別の
     *   操作）を案内する。
     */
    async logout(): Promise<LogoutResult> {
      if (credential === null) return { ok: true };
      try {
        const result = await client.api.POST('/auth/logout', { body: {} });
        if (result.response.status === 401) {
          setCredential(null);
          return { ok: true };
        }
        expectOk(result);
        setCredential(null);
        return { ok: true };
      } catch (error) {
        const message = error instanceof ApiError ? error.message : describeNetworkFailure(error);
        return { ok: false, message };
      }
    },
    /**
     * サーバへは呼ばずに、この画面から鍵だけを捨てる。
     *
     * **`logout()` が失敗したときの逃げ道**（サーバ側は生きたままだが、この
     * 画面からは切り離す）。旧来の「ログアウトは鍵を捨てるだけ」の挙動を
     * 明示的な操作として残したもの。**許可の無いアカウントも `logout()` を
     * 使える**（`/auth/logout` は許可待ちのトークンも通す。issue #1757 ——
     * 捨てたつもりのトークンが、後の `access grant` で生き返らないため）。
     */
    discardCredential: () => setCredential(null),
  };
}

function describeNetworkFailure(error: unknown): string {
  return redactError(error instanceof Error ? error.message : String(error));
}

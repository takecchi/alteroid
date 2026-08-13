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

import { ApiError, unwrap, useApiContext } from '~/lib/api';
import type { StoredAccount } from '~/lib/auth';

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
  /** 実行環境の持ち主のトークンで通っている（`/access` を叩ける）。 */
  operator: boolean;
}

export function useAuth() {
  const { client, baseUrl, credential, setCredential } = useApiContext();

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
           */
          setCredential(null);
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
    revalidate: query.mutate,
    /** ログアウト。**鍵を捨てるだけ**（デーモン側の失効は CLI の仕事）。 */
    logout: () => setCredential(null),
  };
}

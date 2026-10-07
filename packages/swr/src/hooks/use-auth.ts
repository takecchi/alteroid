// `ungranted` を `anonymous` に混ぜない: 混ぜるとログインし直す導線を出すことになり、何度やっても解決しない
import useSWR from 'swr';

import { ApiError, expectOk, unwrap, useApiContext } from '../api';
import { redactError, type StoredAccount } from '@alteroid/logic';

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
  account: StoredAccount | null;
  operator: boolean;
}

export function useAuth() {
  const { client, baseUrl, credential, setCredential, clearCredentialIfCurrent } = useApiContext();

  const query = useSWR<AuthState>(
    { type: 'authState', baseUrl, token: credential?.token ?? null },
    async (): Promise<AuthState> => {
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
          // `/auth/me` の本文は来ない: 引き取り時に控えたアカウントを出す
          return {
            status: 'ungranted',
            providers,
            account: credential.account,
            operator: false,
          };
        }
        if (error instanceof ApiError && error.status === 401) {
          // ここで鍵を捨てる: 401 は正常な状態として返すので `ApiProvider` の共通ハンドラに届かず、失効した鍵が保存先に残り続けるため
          // この応答が使った組を渡す: 遅れて届いた 401 が、切り替え後の有効な鍵を巻き添えにしないため
          clearCredentialIfCurrent(baseUrl, credential.token);
          return { status: 'anonymous', providers, account: null, operator: false };
        }
        throw error;
      }
    },
    // 黙って再試行し続けない: 「繋がらない」と区別が付かなくなるため
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
    isValidating: query.isValidating,
    revalidate: query.mutate,
    // 先にサーバ側のトークンを失効させてから鍵を捨てる: 失敗したときは鍵を捨てない（捨てると、以後サーバ側を失効させる手段が無くなる）
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
    discardCredential: () => setCredential(null),
  };
}

function describeNetworkFailure(error: unknown): string {
  return redactError(error instanceof Error ? error.message : String(error));
}

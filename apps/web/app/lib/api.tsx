import { createAlteroidClient, type AlteroidClient } from '@alteroid/api-client';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { SWRConfig } from 'swr';

import { readCredential, storeCredential, type Credential } from './auth.js';
import { resolveApiBaseUrl, storeApiBaseUrl } from './config.js';

interface ApiContextValue {
  client: AlteroidClient;
  /** いま繋ぎに行っている先。設定画面と診断表示が読む。 */
  baseUrl: string;
  /** 接続先を差し替える（`null` で既定に戻す）。保存して即座に反映する。 */
  setBaseUrl(value: string | null): void;
  /** いまの資格情報（未ログインなら `null`）。 */
  credential: Credential | null;
  /** ログイン結果を保存する（`null` でログアウト）。 */
  setCredential(value: Credential | null): void;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({ children }: { children: ReactNode }) {
  const [baseUrl, setBaseUrlState] = useState(() => resolveApiBaseUrl());
  // 資格情報は**接続先ごと**に持つ（`auth.ts` の冒頭）。
  const [credential, setCredentialState] = useState<Credential | null>(() =>
    readCredential(resolveApiBaseUrl()),
  );

  const client = useMemo(
    () =>
      createAlteroidClient({
        baseUrl,
        /**
         * 資格情報を足すのはここ1か所である。
         *
         * `credentials: 'include'`（Cookie）ではなくヘッダで運ぶ形にしてあるのは、
         * 画面と API のオリジンが違う配置を前提にしているからである（理由は
         * `config.ts` の冒頭）。`createAlteroidClient` は同じ `headers` を SSE 側の
         * `fetch` にも渡すので、これだけで chat と日誌のストリームにも乗る
         * （`EventSource` はヘッダを付けられないが、api-client は使っていない）。
         */
        headers: credential === null ? {} : { authorization: `Bearer ${credential.token}` },
      }),
    [baseUrl, credential],
  );

  const setBaseUrl = useCallback((value: string | null) => {
    storeApiBaseUrl(value);
    const next = resolveApiBaseUrl();
    setBaseUrlState(next);
    // 接続先を変えたら、そのデーモン用の資格情報に持ち替える。
    // **前のデーモンの鍵を新しい相手へ提示しない。**
    setCredentialState(readCredential(next));
  }, []);

  const setCredential = useCallback(
    (value: Credential | null) => {
      storeCredential(baseUrl, value);
      setCredentialState(value);
    },
    [baseUrl],
  );

  const value = useMemo(
    () => ({ client, baseUrl, setBaseUrl, credential, setCredential }),
    [client, baseUrl, setBaseUrl, credential, setCredential],
  );

  /**
   * 期限切れ・失効した鍵を握ったままにしない。
   *
   * トークンには寿命があり（既定 30 日）、更新の仕組みは無い。どこか1つの取得が
   * 401 を返した時点でその鍵はもう通らないので、**捨てて入り口へ戻す**。
   * 捨てると `useAuth` のキーが変わり、shell が `/login` へ送る。
   *
   * **403 では捨てない。** あちらは鍵が有効なまま「許可が無い」なので、捨てると
   * ログインし直す導線に落ちて、何度やっても解決しない画面になる。
   */
  const onError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401 && credential !== null) {
        setCredential(null);
      }
    },
    [credential, setCredential],
  );

  return (
    <ApiContext.Provider value={value}>
      <SWRConfig value={{ onError }}>{children}</SWRConfig>
    </ApiContext.Provider>
  );
}

export function useApiContext(): ApiContextValue {
  const value = useContext(ApiContext);
  if (value === null) throw new Error('useApi は ApiProvider の中でだけ使える');
  return value;
}

/** 型付きの API クライアント。 */
export function useApi(): AlteroidClient {
  return useApiContext().client;
}

/**
 * 応答が失敗だったときに投げる。
 *
 * デーモンの 400 は2種類ある（手書きの `{error}` と、バリデータ既定の
 * `{success:false, error:[...]}`）。**どちらも人間が読める1行に潰す** —
 * 画面が形の違いを気にする必要はないが、握り潰すと「読み込み中のまま止まる」に
 * なるので、必ず投げて `error` として出す。
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** `openapi-fetch` の `{data, error, response}` を SWR が扱える形に均す。 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || result.data === undefined) {
    throw new ApiError(result.response.status, describeError(result.error, result.response));
  }
  return result.data;
}

function describeError(error: unknown, response: Response): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    // zod のバリデーション失敗（`{success:false, error:[...]}`）。
    if (Array.isArray(record.error)) {
      const issues = record.error
        .map((issue) => {
          if (typeof issue !== 'object' || issue === null) return null;
          const { path, message } = issue as { path?: unknown; message?: unknown };
          const where = Array.isArray(path) && path.length > 0 ? `${path.join('.')}: ` : '';
          return typeof message === 'string' ? `${where}${message}` : null;
        })
        .filter((line): line is string => line !== null);
      if (issues.length > 0) return issues.join(' / ');
    }
  }
  return `${response.status} ${response.statusText}`.trim();
}

import { createAlteroidClient, type AlteroidClient } from '@alteroid/api-client';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { resolveApiBaseUrl, storeApiBaseUrl } from './config.js';

interface ApiContextValue {
  client: AlteroidClient;
  /** いま繋ぎに行っている先。設定画面と診断表示が読む。 */
  baseUrl: string;
  /** 接続先を差し替える（`null` で既定に戻す）。保存して即座に反映する。 */
  setBaseUrl(value: string | null): void;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({ children }: { children: ReactNode }) {
  const [baseUrl, setBaseUrlState] = useState(() => resolveApiBaseUrl());

  const client = useMemo(
    () =>
      createAlteroidClient({
        baseUrl,
        /**
         * 資格情報を足すのはここ1か所である。
         *
         * `credentials: 'include'`（Cookie）ではなくヘッダで運ぶ形にしてあるのは、
         * 画面と API のオリジンが違う配置を前提にしているからである（理由は
         * `config.ts` の冒頭）。認証の仕組みが入ったら、ここに `authorization` を
         * 積むだけで全経路（SSE を含む）に乗る — `createAlteroidClient` は同じ
         * `headers` を `fetch` 側にも渡すため。
         */
        headers: {},
      }),
    [baseUrl],
  );

  const setBaseUrl = useCallback((value: string | null) => {
    storeApiBaseUrl(value);
    setBaseUrlState(resolveApiBaseUrl());
  }, []);

  const value = useMemo(() => ({ client, baseUrl, setBaseUrl }), [client, baseUrl, setBaseUrl]);

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
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

import { createAlteroidClient, type AlteroidClient } from '@alteroid/api-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
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
  /**
   * 失効が分かった鍵を捨てる。**その鍵が今も使われているときだけ**画面に効く。
   * 遅れて届いた応答が、別の接続先の有効な鍵を巻き添えにしないための口。
   */
  clearCredentialIfCurrent(baseUrl: string, token: string): void;
}

const ApiContext = createContext<ApiContextValue | null>(null);

/**
 * 「どのデーモンへ、どの鍵で繋いでいるか」。
 *
 * **1つの state にまとめてある。** 別々に持つと、片方だけ新しい状態を見て判断
 * してしまう瞬間ができる（接続先は B なのに鍵は A のつもり、など）。まとめて
 * おけば、更新関数の中で*その時点の*組を丸ごと見て比べられる。
 */
interface Session {
  baseUrl: string;
  credential: Credential | null;
}

export function ApiProvider({ children }: { children: ReactNode }) {
  // 資格情報は**接続先ごと**に持つ（`auth.ts` の冒頭）。
  const [session, setSession] = useState<Session>(() => {
    const baseUrl = resolveApiBaseUrl();
    return { baseUrl, credential: readCredential(baseUrl) };
  });
  const { baseUrl, credential } = session;
  const token = credential?.token ?? null;

  /**
   * クライアントと、その世代の通信をまとめて打ち切るための紐。
   *
   * 接続先や鍵が変わったら**前の世代の通信は打ち切る**。放っておくと、切り替えた
   * 後に古い相手からの応答が届き、いまの状態に対して判断を下してしまう
   * （典型は、A への 401 が B へ切り替えた後に届いて B の鍵を捨てる、というもの）。
   */
  const generation = useMemo(() => {
    const controller = new AbortController();
    const client = createAlteroidClient({
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
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      // **呼び出し側の中断を潰さない。** chat の「受信をやめる」は各リクエストの
      // signal で効いているので、世代の紐と束ねて両方を活かす。
      fetch: (request) =>
        globalThis.fetch(request, {
          signal: AbortSignal.any([request.signal, controller.signal]),
        }),
    });
    return { client, controller, baseUrl, token };
  }, [baseUrl, token]);

  useEffect(() => () => generation.controller.abort(), [generation]);

  const setBaseUrl = useCallback((value: string | null) => {
    storeApiBaseUrl(value);
    const next = resolveApiBaseUrl();
    // 接続先を変えたら、そのデーモン用の資格情報に持ち替える。
    // **前のデーモンの鍵を新しい相手へ提示しない。**
    setSession({ baseUrl: next, credential: readCredential(next) });
  }, []);

  const setCredential = useCallback(
    (value: Credential | null) => {
      storeCredential(baseUrl, value);
      // 書いている間に接続先が変わっていたら、いまの画面には触らない。
      setSession((current) =>
        current.baseUrl === baseUrl ? { ...current, credential: value } : current,
      );
    },
    [baseUrl],
  );

  /**
   * **その鍵が今も使われているときだけ**捨てる。
   *
   * 401 は「この接続先の、この鍵は通らない」という事実であって、「いま画面が
   * 持っている鍵が通らない」ではない。遅れて届いた応答をそのまま今の状態へ
   * 当てはめると、既に別の接続先へ切り替えて有効な鍵を読み込んでいるのに、
   * それを消してしまう。
   *
   * 保存先からは（その接続先のその鍵に限って）消してよい。実際に無効なので。
   */
  const clearCredentialIfCurrent = useCallback((expectedBaseUrl: string, expectedToken: string) => {
    if (readCredential(expectedBaseUrl)?.token === expectedToken) {
      storeCredential(expectedBaseUrl, null);
    }
    setSession((current) =>
      current.baseUrl === expectedBaseUrl && current.credential?.token === expectedToken
        ? { ...current, credential: null }
        : current,
    );
  }, []);

  const value = useMemo(
    () => ({
      client: generation.client,
      baseUrl,
      setBaseUrl,
      credential,
      setCredential,
      clearCredentialIfCurrent,
    }),
    [generation, baseUrl, setBaseUrl, credential, setCredential, clearCredentialIfCurrent],
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
   *
   * ここは**失敗として投げられたものだけ**を見る。401 を正常な戻り値として
   * 扱う経路（`use-auth.ts` は「未ログイン」という状態に翻訳する）は素通りするので、
   * そちらは自分で捨てる。捨て方は同じ `clearCredentialIfCurrent` を共有している。
   *
   * 見るのは**この世代が使っていた鍵**である（いま画面が持っている鍵ではない）。
   * そうしないと、遅れて届いた 401 が別の接続先の鍵を巻き添えにする。
   */
  const onError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401 && generation.token !== null) {
        clearCredentialIfCurrent(generation.baseUrl, generation.token);
      }
    },
    [generation, clearCredentialIfCurrent],
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

import {
  createAlteroidClient,
  readSse,
  type AlteroidClient,
  type ChatMessage,
  type ChatStreamMessage,
} from '@alteroid/api-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { SWRConfig, useSWRConfig } from 'swr';

export type { ChatStreamEvent, ChatStreamPending } from '@alteroid/api-client';

import {
  readCredential,
  storeCredential,
  type Credential,
  listEndpoints,
  migrateSelectionIntoStoredEndpoints,
  normalizeEndpointUrl,
  readStoredEndpoints,
  redactError,
  resolveApiBaseUrl,
  storeApiBaseUrl,
  storeEndpoints,
  upsertEndpoint,
  withoutEndpoint,
  type Endpoint,
  type StoredEndpoint,
} from '@alteroid/logic';

interface ApiContextValue {
  client: AlteroidClient;
  baseUrl: string;
  setBaseUrl(value: string | null): void;
  endpoints: Endpoint[];
  saveEndpoint(entry: StoredEndpoint): void;
  removeEndpoint(url: string): void;
  credential: Credential | null;
  setCredential(value: Credential | null): void;
  clearCredentialIfCurrent(baseUrl: string, token: string): void;
}

const ApiContext = createContext<ApiContextValue | null>(null);

// 接続先と鍵を1つの state にまとめる: 別々に持つと、片方だけ新しい状態を見て判断する瞬間ができる
interface Session {
  baseUrl: string;
  credential: Credential | null;
}

export function ApiProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>(() => {
    const baseUrl = resolveApiBaseUrl();
    return { baseUrl, credential: readCredential(baseUrl) };
  });
  const { baseUrl, credential } = session;
  const token = credential?.token ?? null;

  const [saved, setSaved] = useState<StoredEndpoint[]>(() => {
    migrateSelectionIntoStoredEndpoints();
    return readStoredEndpoints();
  });

  const generation = useMemo(() => {
    const controller = new AbortController();
    const client = createAlteroidClient({
      baseUrl,
      // Cookie（`credentials: 'include'`）ではなくヘッダで運ぶ: 画面と API のオリジンが違う配置を前提にしているため
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      // 呼び出し側の signal を潰さず世代の signal と束ねる: chat の「受信をやめる」が各リクエストの signal で効いているため
      fetch: (request) =>
        globalThis.fetch(request, {
          signal: AbortSignal.any([request.signal, controller.signal]),
        }),
    });
    return { client, controller, baseUrl, token };
  }, [baseUrl, token]);

  // cleanup で即座に abort しない: StrictMode は同じ世代のまま mount → cleanup → mount を行うので、
  // abort 済みの signal が以後の全リクエストに残って落ちる。1拍遅らせて予約し、張り直されたら取り消す
  const pendingAbort = useRef<{
    generation: typeof generation;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ generation, timer: null });
  useEffect(() => {
    const pending = pendingAbort.current;
    if (pending.timer !== null) clearTimeout(pending.timer);
    if (pending.generation !== generation) pending.generation.controller.abort();
    pendingAbort.current = { generation, timer: null };
    return () => {
      const timer = setTimeout(() => generation.controller.abort(), 0);
      pendingAbort.current = { generation, timer };
    };
  }, [generation]);

  const { mutate } = useSWRConfig();
  const previousBaseUrl = useRef(baseUrl);
  useEffect(() => {
    if (previousBaseUrl.current === baseUrl) return;
    previousBaseUrl.current = baseUrl;
    // 全キーを引き直す: SWR キーの大半は接続先を含まず、種別を選ぶと選び漏れが前の接続先の表示として残る
    void mutate(() => true);
  }, [baseUrl, mutate]);

  const setBaseUrl = useCallback((value: string | null) => {
    storeApiBaseUrl(value);
    const next = resolveApiBaseUrl();
    // 前のデーモンの鍵を新しい相手へ提示しない
    setSession({ baseUrl: next, credential: readCredential(next) });
  }, []);

  // `saved` ではなく localStorage を起点にする: 別タブの追加を踏み潰さないため
  const saveEndpoint = useCallback((entry: StoredEndpoint) => {
    const next = upsertEndpoint(readStoredEndpoints(), entry);
    storeEndpoints(next);
    setSaved(next);
  }, []);

  const removeEndpoint = useCallback(
    (url: string) => {
      const next = withoutEndpoint(readStoredEndpoints(), url);
      storeEndpoints(next);
      setSaved(next);
      // 選択を残さない: 一覧に無い接続先へ繋ぎ続けたまま「消した」と表示されるため
      const target = normalizeEndpointUrl(url);
      if (target !== undefined && resolveApiBaseUrl() === target) setBaseUrl(null);
    },
    [setBaseUrl],
  );

  // `baseUrl` を渡す: `listEndpoints` の既定引数（localStorage）だと、切り替え直後の render に古い値が混じる
  const endpoints = useMemo(() => listEndpoints(saved, undefined, baseUrl), [saved, baseUrl]);

  const setCredential = useCallback(
    (value: Credential | null) => {
      storeCredential(baseUrl, value);
      setSession((current) =>
        current.baseUrl === baseUrl ? { ...current, credential: value } : current,
      );
    },
    [baseUrl],
  );

  // その鍵が今も使われているときだけ画面の状態を捨てる: 遅れて届いた 401 が、切り替え後の別の接続先の有効な鍵を消さないため
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
      endpoints,
      saveEndpoint,
      removeEndpoint,
      credential,
      setCredential,
      clearCredentialIfCurrent,
    }),
    [
      generation,
      baseUrl,
      setBaseUrl,
      endpoints,
      saveEndpoint,
      removeEndpoint,
      credential,
      setCredential,
      clearCredentialIfCurrent,
    ],
  );

  // 403 では捨てない: 鍵は有効で許可が無いだけなので、捨てると何度やっても解決しないログイン導線に落ちる。
  // 見る鍵は画面の現在値ではなくこの世代のもの: 遅れて届いた 401 が別の接続先の鍵を巻き添えにするため
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
      <SWRConfig value={{ onError, onErrorRetry }}>{children}</SWRConfig>
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

// 待っても直らない失敗の番号: 同じ要求を繰り返しても同じ答えが返り、取り直しは負荷と記録の雑音にしかならないため
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 409, 422]);

// 止めるのは裏の自動の取り直しだけ: 人間が押す「もう一度試す」と focus での取り直しは `mutate`・再検証で、ここを通らない。
// 既定の間隔の計算は自前で書き写さず `SWRConfig.defaultValue` のものを呼ぶ: `config.onErrorRetry` は自分自身で、呼ぶと再帰するため
function onErrorRetryExcept(
  permanent: ReadonlySet<number>,
): typeof SWRConfig.defaultValue.onErrorRetry {
  return (error, key, config, revalidate, opts) => {
    if (error instanceof ApiError && permanent.has(error.status)) return;
    SWRConfig.defaultValue.onErrorRetry(error, key, config, revalidate, opts);
  };
}

const onErrorRetry = onErrorRetryExcept(PERMANENT_STATUSES);

// 404 だけは取り直す版: 出来たら現れるものを待つ読み（作ったばかりの会話。`useConversation` の `retryOnNotFound` の既定）が、全体の設定で黙って待たなくなるのを防ぐため
export const onErrorRetryKeepingNotFound = onErrorRetryExcept(
  new Set([...PERMANENT_STATUSES].filter((status) => status !== 404)),
);

export class ApiError extends Error {
  readonly status: number;
  /** サーバが本文に載せた機械向けの印。画面は `message` の文言ではなくこれで場合分けする。 */
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(redactError(message));
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || result.data === undefined) {
    throw new ApiError(
      result.response.status,
      describeError(result.error, result.response),
      errorCode(result.error),
    );
  }
  return result.data;
}

// `client.chat()` ではなく `client.api.POST('/chat')` を使う: 手書きの型を足さず、生成 spec のまま `supersedes` を運ぶため。
// SSE の読み取りは自前で書き直さず `readSse` を使う: `api-client` の実装を二重管理しないため
export async function* postChat(
  client: AlteroidClient,
  input: {
    text: string;
    conversationId?: string;
    supersedes?: string;
    attachments?: readonly string[];
    clientMessageId?: string;
  },
  options?: { signal?: AbortSignal },
): AsyncGenerator<ChatMessage> {
  const result = await client.api.POST('/chat', {
    body: {
      text: input.text,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      ...(input.attachments === undefined || input.attachments.length === 0
        ? {}
        : { attachments: [...input.attachments] }),
      ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
    },
    parseAs: 'stream',
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
  const body = unwrap(result);
  if (body === null) throw new Error('/chat の応答に本文が無い');
  for await (const message of readSse(body)) {
    yield {
      event: message.event,
      data: message.data === '' ? undefined : JSON.parse(message.data),
    } as ChatMessage;
  }
}

export async function uploadAttachment(
  client: AlteroidClient,
  file: Blob,
  meta: { name: string; type: string },
  options?: { signal?: AbortSignal },
) {
  const result = await client.api.POST('/attachments', {
    params: { query: { name: meta.name, type: meta.type } },
    body: file as unknown as string,
    // `openapi-fetch` 既定の JSON 直列化を通さず Blob をそのまま送る: 本文は生のバイト列で、デーモンは octet-stream 以外を 415 で拒むため
    bodySerializer: (body: unknown) => body as BodyInit,
    headers: { 'content-type': 'application/octet-stream' },
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
  return unwrap(result);
}

export class AttachmentGoneError extends Error {
  constructor() {
    super('添付を取り出せない（期限切れの可能性）');
    this.name = 'AttachmentGoneError';
  }
}

export async function fetchAttachment(
  client: AlteroidClient,
  id: string,
  options?: { signal?: AbortSignal },
): Promise<Blob> {
  const result = await client.api.GET('/attachments/{id}', {
    params: { path: { id } },
    parseAs: 'blob',
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.response.status === 404) throw new AttachmentGoneError();
  return unwrap(result) as unknown as Blob;
}

// `client.chatStream()` ではなく型付きの `client.api` を通す: `postChat` と同じ理由
export async function* getChatStream(
  client: AlteroidClient,
  conversationId: string,
  options?: { signal?: AbortSignal },
): AsyncGenerator<ChatStreamMessage> {
  const result = await client.api.GET('/chat/{conversationId}/stream', {
    params: { path: { conversationId } },
    parseAs: 'stream',
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
  const body = unwrap(result);
  if (body === null) throw new Error('/chat/:conversationId/stream の応答に本文が無い');
  for await (const message of readSse(body)) {
    yield {
      event: message.event,
      data: message.data === '' ? undefined : JSON.parse(message.data),
    } as ChatStreamMessage;
  }
}

// `unwrap` ではなく成否だけを見る: `unwrap` は本文が空の 200 を失敗として投げるため、結果を使わない書き込みには合わない
export function expectOk(result: { error?: unknown; response: Response }): void {
  if (result.error === undefined && result.response.ok) return;
  throw new ApiError(result.response.status, describeError(result.error, result.response));
}

function describeError(error: unknown, response: Response): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
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

/** 受け取っていなければ（404）`undefined`。それ以外の失敗は投げる（「受け取っていない」と「確かめられなかった」を取り違えない）。 */
export async function findConversationByClientMessageId(
  client: AlteroidClient,
  clientMessageId: string,
  options?: { signal?: AbortSignal },
): Promise<string | undefined> {
  const result = await client.api.GET('/client-messages/{clientMessageId}', {
    params: { path: { clientMessageId } },
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.response.status === 404) return undefined;
  return unwrap(result).conversationId;
}

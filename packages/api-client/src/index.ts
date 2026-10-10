import { redactedExcerpt } from '@alteroid/core/redact';
import createClient, { type Client, type ClientOptions } from 'openapi-fetch';

import type { paths } from './generated/openapi.js';
import { readSse } from './sse.js';

export type { paths } from './generated/openapi.js';
export { readSse, type SseMessage } from './sse.js';

export type ChatStreamEvent =
  paths['/chat']['post']['responses'][200]['content']['text/event-stream'];

export type JournalEntry =
  paths['/journal/stream']['get']['responses'][200]['content']['text/event-stream'];

// `open` に `type` を捏造しない: 線の上を書き換えると、spec とコードのどちらが正しいか分からなくなるため。`event` 名で判別する。
export type ChatMessage =
  | {
      event: 'open';
      data: { conversationId: string; clientMessageId?: string; duplicate?: boolean };
    }
  | { event: ChatStreamEvent['type']; data: ChatStreamEvent };

/** 再生の `open` が運ぶ、その会話でいま答えを待っている発言。 */
export interface ChatStreamPending {
  clientMessageId: string;
  state: 'running' | 'starting' | 'held' | 'queued';
}

// `pending` を省けるのは、運ばない古いデーモンのため。
export type ChatStreamMessage =
  | {
      event: 'open';
      data: { conversationId: string; inProgress: boolean; pending?: ChatStreamPending[] };
    }
  | { event: ChatStreamEvent['type']; data: ChatStreamEvent };

export type JournalMessage =
  { event: 'open'; data: { ok: boolean } } | { event: JournalEntry['type']; data: JournalEntry };

export type TopologySnapshot =
  paths['/topology']['get']['responses'][200]['content']['application/json'];

export type TopologyMessage =
  { event: 'snapshot'; data: TopologySnapshot } | { event: 'unavailable'; data: { error: string } };

// 先に切らず伏せてから切る: 切り口で割れたトークンの断片が残るため。`@alteroid/core` 本体を import しない: 実行時の依存に持たず、Web の画面も読むため。
const ERROR_BODY_LIMIT = 512;

export interface AlteroidClientOptions extends Omit<ClientOptions, 'baseUrl' | 'headers'> {
  baseUrl: string;
  // 素の対にする: SSE 側の `fetch` にも同じものをそのまま渡すため。
  headers?: Record<string, string>;
}

export interface ChatInput {
  text: string;
  /** 続きから話すなら、前回の `open` で受け取った id を渡す。 */
  conversationId?: string;
  /** 置き換える発言の日誌エントリ id。クローンの応答は指せない: デーモンが 400 で弾くため。 */
  supersedes?: string;
  clientMessageId?: string;
}

export interface StreamOptions {
  signal?: AbortSignal;
}

export interface JournalStreamOptions extends StreamOptions {
  // API 側で絞らない: 見えない層を作らないため。
  types?: readonly JournalEntry['type'][];
}

export interface AlteroidClient {
  api: Client<paths>;
  chat(input: ChatInput, options?: StreamOptions): AsyncGenerator<ChatMessage>;
  chatStream(conversationId: string, options?: StreamOptions): AsyncGenerator<ChatStreamMessage>;
  journalStream(options?: JournalStreamOptions): AsyncGenerator<JournalMessage>;
  topologyStream(options?: StreamOptions): AsyncGenerator<TopologyMessage>;
}

// `content-type: application/json` を消さない: `chat()` は素の `fetch` で送り、SSE は openapi-fetch を通らないため。
export function createAlteroidClient(options: AlteroidClientOptions): AlteroidClient {
  const { baseUrl, headers, fetch: fetchImpl, ...rest } = options;
  const defaultHeaders = { 'content-type': 'application/json', ...(headers ?? {}) };

  const api = createClient<paths>({
    baseUrl,
    headers: defaultHeaders,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    ...rest,
  });

  const doFetch = (input: string, init: RequestInit): Promise<Response> =>
    fetchImpl === undefined ? globalThis.fetch(input, init) : fetchImpl(new Request(input, init));

  async function* stream(
    path: string,
    init: RequestInit,
  ): AsyncGenerator<{ event: string; data: unknown }> {
    const response = await doFetch(join(baseUrl, path), {
      ...init,
      headers: { ...defaultHeaders, ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      throw new Error(
        `${path} が ${response.status} を返した: ${redactedExcerpt(
          await response.text(),
          ERROR_BODY_LIMIT,
          // `process.env` を読まない: ブラウザでも動くため。
          undefined,
        )}`,
      );
    }
    if (response.body === null) throw new Error(`${path} の応答に本文が無い`);

    for await (const message of readSse(response.body)) {
      yield {
        event: message.event,
        data: message.data === '' ? undefined : JSON.parse(message.data),
      };
    }
  }

  return {
    api,

    async *chat(input, streamOptions) {
      const body = JSON.stringify({
        text: input.text,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
        ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
      });
      const init: RequestInit = {
        method: 'POST',
        body,
        ...(streamOptions?.signal === undefined ? {} : { signal: streamOptions.signal }),
      };
      yield* stream('/chat', init) as AsyncGenerator<ChatMessage>;
    },

    async *chatStream(conversationId, streamOptions) {
      const init: RequestInit = {
        method: 'GET',
        ...(streamOptions?.signal === undefined ? {} : { signal: streamOptions.signal }),
      };
      yield* stream(
        `/chat/${encodeURIComponent(conversationId)}/stream`,
        init,
      ) as AsyncGenerator<ChatStreamMessage>;
    },

    async *journalStream(streamOptions) {
      const types = streamOptions?.types;
      const query =
        types === undefined || types.length === 0
          ? ''
          : `?type=${encodeURIComponent(types.join(','))}`;
      const init: RequestInit = {
        method: 'GET',
        ...(streamOptions?.signal === undefined ? {} : { signal: streamOptions.signal }),
      };
      yield* stream(`/journal/stream${query}`, init) as AsyncGenerator<JournalMessage>;
    },

    async *topologyStream(streamOptions) {
      const init: RequestInit = {
        method: 'GET',
        ...(streamOptions?.signal === undefined ? {} : { signal: streamOptions.signal }),
      };
      yield* stream('/topology/stream', init) as AsyncGenerator<TopologyMessage>;
    },
  };
}

function join(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

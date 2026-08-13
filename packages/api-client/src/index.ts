/**
 * @alteroid/api-client — デーモンの HTTP API を**外から**叩くためのクライアント。
 *
 * 型は `apps/daemon/openapi.json`（コードの zod スキーマから機械生成された spec）
 * から `openapi-typescript` で起こす。手書きの型を置くと spec と二重管理になり、
 * 必ずずれる（Issue #20）。
 *
 * 対象は**デーモンの API だけ**である。runner の API は制御面であって外へ出す
 * ものではない（触れると、自分宛の許可確認に自分で答えられる — AGENTS.md）。
 *
 * リポジトリ内の CLI はこれを使わない。同一リポジトリからは `hono/client` の
 * 型共有で足りているので、無理に置き換えない（Issue #20「設計上の注意」）。
 */

import createClient, { type Client, type ClientOptions } from 'openapi-fetch';

import type { paths } from './generated/openapi.js';
import { readSse } from './sse.js';

export type { paths } from './generated/openapi.js';
export { readSse, type SseMessage } from './sse.js';

/** 生成 spec から起こした「chat の SSE で流れる 1 イベント」。 */
export type ChatStreamEvent =
  paths['/chat']['post']['responses'][200]['content']['text/event-stream'];

/** 生成 spec から起こした「日誌の SSE で流れる 1 エントリ」。 */
export type JournalEntry =
  paths['/journal/stream']['get']['responses'][200]['content']['text/event-stream'];

/**
 * chat の SSE メッセージ。
 *
 * `open` だけは本文の形が違う（会話 id を返すためだけのもので、以降のイベントの
 * ような `type` を持たない）。**そこを揃えて見せるために `type` を捏造しない** —
 * クライアントが線の上を書き換えたら、spec とコードのどちらが正しいのか誰にも
 * 分からなくなる。だから `event` 名で判別する形をそのまま出す。
 */
export type ChatMessage =
  | { event: 'open'; data: { conversationId: string } }
  | { event: ChatStreamEvent['type']; data: ChatStreamEvent };

/** 日誌の SSE メッセージ。`open` は配線が生きていることの合図だけを運ぶ。 */
export type JournalMessage =
  { event: 'open'; data: { ok: boolean } } | { event: JournalEntry['type']; data: JournalEntry };

export interface AlteroidClientOptions extends Omit<ClientOptions, 'baseUrl' | 'headers'> {
  /** 例: `http://127.0.0.1:4517`。 */
  baseUrl: string;
  /**
   * 既定のヘッダ。`content-type: application/json` は明示しなくても付く。
   * （`Headers` や配列ではなく素の対にしているのは、SSE 側の `fetch` にも
   * 同じものをそのまま渡すためである。）
   */
  headers?: Record<string, string>;
}

export interface ChatInput {
  text: string;
  /** 続きから話すなら、前回の `open` で受け取った id を渡す。 */
  conversationId?: string;
}

export interface StreamOptions {
  /** 読むのをやめるとき。渡さなくても `break` すれば本文は解放される。 */
  signal?: AbortSignal;
}

export interface JournalStreamOptions extends StreamOptions {
  /**
   * 受け取る日誌エントリの種別。**省略すると全部流れる。**
   * 選り分けるのは呼ぶ側の仕事で、API 側は絞らない（見えない層を作らないため）。
   */
  types?: readonly JournalEntry['type'][];
}

export interface AlteroidClient {
  /** 生成 spec そのままの型付き fetch クライアント（`GET` / `POST` / …）。 */
  api: Client<paths>;
  /** クローンに話しかけ、返答を SSE で受け取る。 */
  chat(input: ChatInput, options?: StreamOptions): AsyncGenerator<ChatMessage>;
  /** 日誌への追記を SSE で受け取る（承認待ちが出たことに気づける口）。 */
  journalStream(options?: JournalStreamOptions): AsyncGenerator<JournalMessage>;
}

/**
 * クライアントを作る。
 *
 * `content-type: application/json` を既定で必ず付けるのは、デーモンが**本文の
 * 無い POST**（会話終了・定期ジョブの手動起動・停止）にもこれを要求するからで
 * ある。ブラウザの単純リクエストで他人がクローンのターンを起こせないようにする
 * 境界（`deliberateClient`）であり、意図した呼び出し側はここを素通りできる必要が
 * ある。CLI の `hono/client` が同じことをしているのと同じ理由（`apps/cli/src/client.ts`）。
 */
export function createAlteroidClient(options: AlteroidClientOptions): AlteroidClient {
  const { baseUrl, headers, fetch: fetchImpl, ...rest } = options;
  const defaultHeaders = { 'content-type': 'application/json', ...(headers ?? {}) };

  const api = createClient<paths>({
    baseUrl,
    headers: defaultHeaders,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    ...rest,
  });

  // SSE は openapi-fetch を通さない（応答本文を自分で解く必要がある）ので、
  // 差し替えられた `fetch` があればここでも同じものを使う。
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
      throw new Error(`${path} が ${response.status} を返した: ${await response.text()}`);
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
      });
      const init: RequestInit = {
        method: 'POST',
        body,
        ...(streamOptions?.signal === undefined ? {} : { signal: streamOptions.signal }),
      };
      yield* stream('/chat', init) as AsyncGenerator<ChatMessage>;
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
  };
}

/** `baseUrl` の末尾スラッシュの有無で経路が壊れないようにする。 */
function join(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

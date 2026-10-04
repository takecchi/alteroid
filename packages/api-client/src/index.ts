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

import { redactedExcerpt } from '@alteroid/core/redact';
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

/**
 * 途中経過に戻る口（`GET /chat/:conversationId/stream`）の SSE メッセージ。
 *
 * `open` は `POST /chat` のものと形が違う。`inProgress` が false なら、進行中のターンが
 * 無いので `open` だけで終わる。true なら、いままでの分（`queued` / `thinking` / `tool` /
 * `text` / …。隣り合う `text` は1つ）が続き、そのあとに続きが来て、`done` / `error` で終わる。
 */
export type ChatStreamMessage =
  | { event: 'open'; data: { conversationId: string; inProgress: boolean } }
  | { event: ChatStreamEvent['type']; data: ChatStreamEvent };

/** 日誌の SSE メッセージ。`open` は配線が生きていることの合図だけを運ぶ。 */
export type JournalMessage =
  { event: 'open'; data: { ok: boolean } } | { event: JournalEntry['type']; data: JournalEntry };

/** 生成 spec から起こした「稼働の地図」（`GET /topology` と、SSE の `snapshot` の本文）。 */
export type TopologySnapshot =
  paths['/topology']['get']['responses'][200]['content']['application/json'];

/**
 * 稼働の地図の SSE メッセージ（`GET /topology/stream`）。
 *
 * `unavailable` は「組めなかった」の合図で、本文は種別だけ（`{ error }`）。**直前の
 * `snapshot` は古いまま**なので、読み手は「いまの状態」として出し続けない。heartbeat
 * （`:` で始まるコメント行）は `readSse` が捨てるので、ここへは届かない。
 */
export type TopologyMessage =
  { event: 'snapshot'; data: TopologySnapshot } | { event: 'unavailable'; data: { error: string } };

/**
 * SSE の口が ok でない応答を受けたとき、Error の message に入れる本文の長さの上限
 * （issue #2418）。本文は中継（プロキシ）や古いデーモンが返す任意の文字列で、鍵や
 * URL の資格を含みうる。**伏せてから切る**（`@alteroid/core/redact` の
 * `redactedExcerpt`）——先に切ると、切り口で割れたトークンの断片が残る。
 * status と path は message に別に残る。
 *
 * **`@alteroid/core` 本体を import しない。** このパッケージは core を実行時の依存に
 * 持たず、`packages/swr` 経由で Web の画面も読む。軽い口（`/redact`）は
 * `process.env` を自分では読まない。
 */
const ERROR_BODY_LIMIT = 512;

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
  /**
   * 送信済みの自分の発言を編集するとき、置き換える発言の日誌エントリ id
   * （`GET /conversations/:id` の `messages[].id`）。`conversationId` と一緒に渡す。
   *
   * **日誌は書き換わらない。** 編集は `supersedes` を持つ新しい発言として追記され、
   * 旧発言は会話の既定ビューから外れるだけである（畳まれた分は
   * `GET /conversations/:id?includeSuperseded=true` で読める）。
   * **クローンの応答は指せない** — 指すとデーモンが 400 で弾く。
   */
  supersedes?: string;
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
  /**
   * 進行中のターンの途中経過に戻り、続きを SSE で受け取る（発言は投函しない）。
   * 画面を離れた・読み込み直したあとに、`chat()` で始めたターンへ戻るための口。
   * CLI・TUI・Web のどれもこの1本に乗る。
   */
  chatStream(conversationId: string, options?: StreamOptions): AsyncGenerator<ChatStreamMessage>;
  /** 日誌への追記を SSE で受け取る（承認待ちが出たことに気づける口）。 */
  journalStream(options?: JournalStreamOptions): AsyncGenerator<JournalMessage>;
  /** 稼働の地図を SSE で受け取る（開いたとき1回、以後は内容が変わったときだけ）。 */
  topologyStream(options?: StreamOptions): AsyncGenerator<TopologyMessage>;
}

/**
 * クライアントを作る。
 *
 * `content-type: application/json` を既定で必ず付けるのは、デーモンが**本文を読まない
 * POST / DELETE**（会話終了・定期の依頼を外す・定期ジョブの手動起動・停止・許可の付与と
 * 取り消し）にもこれを要求するからである。ブラウザの単純リクエストで他人がクローンのターンを起こせないようにする
 * 境界（`deliberateClient`）であり、意図した呼び出し側はここを素通りできる必要がある。
 * CLI の `hono/client` が同じことをしているのと同じ理由（`apps/cli/src/client.ts`）。
 *
 * **これを消しても `api` 経由は動くが、それを理由に消さないこと。** 門番つきの経路は spec 側で
 * requestBody を `required` にしてあるので、`body: {}` を渡す呼び出しには openapi-fetch が
 * 自分でヘッダを付ける（それが本筋で、`packages/api-client/src/client.test.ts` が型と実行時の
 * 両方で固定している）。ここがまだ要るのは **SSE が openapi-fetch を通らない**からで、
 * `chat()` は素の `fetch` で `POST /chat` へ本文を送るため、ヘッダを付けるのはこちらの仕事に
 * なる。
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
      throw new Error(
        `${path} が ${response.status} を返した: ${redactedExcerpt(
          await response.text(),
          ERROR_BODY_LIMIT,
          // ブラウザ（Web の画面）でも動くので `process.env` は読まない。
          // 字面の規則（既知の形・URL の資格・`params:` 以降）だけを使う。
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

/** `baseUrl` の末尾スラッシュの有無で経路が壊れないようにする。 */
function join(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

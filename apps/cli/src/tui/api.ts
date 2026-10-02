/**
 * TUI が使うデーモンの口。**新しい経路は 1 つも足さない** — Web UI と既存 CLI が使っている
 * 経路を、既存の `resolveTarget()`（接続・認証）と `createClient()`（hono/client）の上から
 * 呼ぶだけである。SSE（`POST /chat` と `GET /journal/stream`）は hono/client では読めない
 * ので、既存 CLI の `chat.ts` と同じく生の fetch で受ける（認証ヘッダはそこにも要る）。
 *
 * 画面（`chat-controller.ts` / `app.tsx`）はこの `TuiApi` インターフェースだけを見る。
 * 試験では偽物を渡す。
 */
import { createClient } from '../client.js';
import { withErrorReason } from '../format.js';
import { describeInterruptOutcome } from '../interrupt.js';
import { describeAuthFailure, type Target } from '../target.js';
import { readSSE } from './sse.js';

/** `POST /chat` の SSE イベント（`apps/daemon/src/app.ts` の `/chat`。Web と同じ語彙）。 */
export type ChatEvent =
  | { type: 'open'; conversationId: string }
  | { type: 'queued' }
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: string }
  | { type: 'ask_human'; approvalId: string; question: string }
  | { type: 'usage_limited'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface ConversationSummary {
  conversationId: string;
  startedAt: string;
  updatedAt: string;
  messages: number;
  preview: string;
}

export interface ConversationMessage {
  id: string;
  at: string;
  /** `inbound` = 人間の発言 / `outbound` = クローンの返答。 */
  role: 'inbound' | 'outbound';
  text: string;
}

export interface HeaderCounts {
  /** 未回答の承認待ち。読めない行（`unreadable`）は数えない。 */
  pendingApprovals: number;
  /** 状態が `running` の委譲。 */
  runningManagers: number;
}

export interface TuiApi {
  /** 接続先（ヘッダに出す）。 */
  readonly baseUrl: string;
  /** 失敗（HTTP エラー・接続断）は `ApiError` を投げる。 */
  chat(
    input: { text: string; conversationId?: string },
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent>;
  listConversations(): Promise<ConversationSummary[]>;
  /** `null` は 404（遡り切れた上で「無い」）。 */
  readConversation(id: string): Promise<ConversationMessage[] | null>;
  endConversation(id: string): Promise<void>;
  /** 結果を人間の言葉にしたもの（`alteroid interrupt` と同じ文言）。 */
  interrupt(): Promise<string>;
  headerCounts(): Promise<HeaderCounts>;
  /** `GET /journal/stream`。接続できたとき `open`、以後は届いたエントリの種別（`exchange` など）を流す。 */
  journalStream(signal: AbortSignal): AsyncGenerator<string>;
}

/** 人間へそのまま見せてよい文言を持つ失敗。 */
export class ApiError extends Error {}

const CHAT_EVENT_NAMES = new Set([
  'open',
  'queued',
  'thinking',
  'text',
  'tool',
  'ask_human',
  'usage_limited',
  'error',
  'done',
]);

export function createTuiApi(target: Target): TuiApi {
  const client = createClient(target.baseUrl, target.headers);

  /** 応答が失敗なら、認証の案内かデーモンの理由つきで `ApiError` にする。 */
  async function failure(
    what: string,
    response: Response | { status: number; json: () => Promise<unknown> },
  ): Promise<ApiError> {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) return new ApiError(described);
    return new ApiError(
      await withErrorReason(`${what}（HTTP ${String(response.status)}）`, response),
    );
  }

  async function* openStream(
    path: string,
    init: { method: string; body?: string },
    what: string,
    signal: AbortSignal,
  ): AsyncGenerator<{ name: string; json: <T>() => T | null }> {
    let response: Response;
    try {
      response = await fetch(`${target.baseUrl}${path}`, {
        method: init.method,
        headers: { ...target.headers, 'content-type': 'application/json' },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      throw new ApiError(`${what}: デーモンに繋がりません（${String(error)}）`);
    }
    if (!response.ok || !response.body) throw await failure(what, response);
    try {
      for await (const event of readSSE(response.body)) yield event;
    } catch (error) {
      if (signal.aborted) return;
      throw new ApiError(`${what}: 接続が切れました（${String(error)}）`);
    }
  }

  return {
    baseUrl: target.baseUrl,

    async *chat(input, signal) {
      const body = JSON.stringify({
        text: input.text,
        conversationId: input.conversationId ?? undefined,
      });
      for await (const event of openStream(
        '/chat',
        { method: 'POST', body },
        '送信できませんでした',
        signal,
      )) {
        if (!CHAT_EVENT_NAMES.has(event.name)) continue;
        const data = event.json<Record<string, unknown>>() ?? {};
        yield { ...data, type: event.name } as ChatEvent;
      }
    },

    async listConversations() {
      const response = await client.conversations.$get({ query: {} });
      if (!response.ok) throw await failure('会話の一覧を読めませんでした', response);
      return (await response.json()).conversations;
    },

    async readConversation(id) {
      const response = await client.conversations[':id'].$get({ param: { id }, query: {} });
      if (response.status === 404) return null;
      if (!response.ok) throw await failure('会話を読めませんでした', response);
      return (await response.json()).messages;
    },

    async endConversation(id) {
      const response = await client.chat[':conversationId'].end.$post({
        param: { conversationId: id },
      });
      if (!response.ok) throw await failure('会話を終えられませんでした', response);
    },

    async interrupt() {
      const response = await client.clone.interrupt.$post();
      if (!response.ok) throw await failure('クローンのターンを止められませんでした', response);
      return describeInterruptOutcome((await response.json()).outcome);
    },

    async headerCounts() {
      const [approvals, managers] = await Promise.all([
        client.approvals.$get({ query: {} }),
        client.managers.$get({ query: {} }),
      ]);
      if (!approvals.ok) throw await failure('承認待ちを読めませんでした', approvals);
      if (!managers.ok) throw await failure('委譲を読めませんでした', managers);
      return {
        pendingApprovals: (await approvals.json()).approvals.length,
        runningManagers: (await managers.json()).managers.filter((m) => m.status === 'running')
          .length,
      };
    },

    async *journalStream(signal) {
      for await (const event of openStream(
        '/journal/stream',
        { method: 'GET' },
        '日誌の購読',
        signal,
      )) {
        yield event.name;
      }
    },
  };
}

/**
 * TUI が使うデーモンの口。**新しい経路は 1 つも足さない** — Web UI と既存 CLI が使っている
 * 経路を、既存の `resolveTarget()`（接続・認証）と `createClient()`（hono/client）の上から
 * 呼ぶだけである。SSE（`POST /chat` と `GET /journal/stream`）は hono/client では読めない
 * ので、既存 CLI の `chat.ts` と同じく生の fetch で受ける（認証ヘッダはそこにも要る）。
 *
 * 画面（`chat-controller.ts` / `app.tsx`）はこの `TuiApi` インターフェースだけを見る。
 * 試験では偽物を渡す。
 */
import type { JournalEntry } from '@alteroid/core';

import { createClient } from '../client.js';
import { withErrorReason } from '../format.js';
import { describeInterruptOutcome } from '../interrupt.js';
import type { MemorySummary } from '../memory.js';
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

/** 委譲の状態（`jobStatusSchema` の 6 値）。 */
export type ManagerStatus = 'running' | 'waiting_human' | 'done' | 'failed' | 'lost' | 'stopped';

/**
 * 一覧・詳細が見るマネージャー 1 本の欄（`GET /managers` と `GET /managers/{id}` は同じ
 * `managerSummarySchema`）。TUI が使う欄だけに絞る — 使わない欄を型に持ち込まない。
 */
export interface ManagerRow {
  managerId: string;
  status: ManagerStatus;
  /** デーモンが今その runner と繋がっているか。 */
  live: boolean;
  awaitingBackground?: { tasks: number; since?: string };
  request: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  lastReport?: string;
  lastReportAt?: string;
  lastFailure?: { code: string; via: string; at: string };
  waiting: { requestId: string; summary: string; kind?: string }[];
  runnerLostSince?: string;
  runnerVanished?: boolean;
  sessionMissingSince?: string;
  appraisal?: string;
}

/** 読めない委譲の行（壊れた行。「居ない」でも「畳まれた」でもない）。 */
export interface UnreadableManager {
  id?: string;
  reason: string;
}

export interface ManagerListQuery {
  /** カンマ区切りにして渡す。空なら絞らない。 */
  status?: readonly ManagerStatus[];
  limit?: number;
  /** 錨（`startedAt` 降順の「より古い側」を返す）。組で渡す。 */
  after?: { managerId: string; startedAt: string };
}

/** 委譲の操作（追加指示・停止）の結果。デーモンの `outcome` / `detail` をそのまま持つ。 */
export interface ManagerActionResult {
  outcome: string;
  detail: string;
}

/** 記憶の一覧の 1 件。CLI `memory list` と同じ型に、Web の一覧が出す大きさ（`bytes`）を足したもの。 */
export type MemoryRow = MemorySummary & { bytes?: number };

/** `GET /memory/{slug}` の `document`（TUI が使う欄だけ）。 */
export interface MemoryDoc {
  slug: string;
  content: string;
  createdAt: MemorySummary['createdAt'];
  updatedAt: string;
}

/** `GET /journal` の問い合わせ（Web の `useJournalWindow` と同じ欄）。 */
export interface JournalListQuery {
  limit: number;
  /** 種別（カンマ区切りにして渡す）。空なら絞らない。 */
  types?: readonly string[];
  /** 本文を語で探す（空なら渡さない）。 */
  q?: string;
  since?: string;
  until?: string;
  /** 絞らずに日誌の地平（`oldestAt` / `crossesHorizon`）も欲しいとき。 */
  horizon?: boolean;
}

export interface JournalListResult {
  /** 新しい順。 */
  entries: JournalEntry[];
  oldestAt?: string | null;
  crossesHorizon?: boolean;
}

/** `GET /journal/stream` で届いた 1 件。`open` と、本体が読めなかったものは `entry` が `null`。 */
export interface JournalStreamItem {
  type: string;
  entry: JournalEntry | null;
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
  /**
   * `null` は 404（遡り切れた上で「無い」）。`reachedStart` が偽なら、窓の外に続き（古い発言）が
   * 残っているかもしれない。`messages` が空でこれが偽のときは「無い」ではなく**判定できない**。
   */
  readConversation(
    id: string,
  ): Promise<{ messages: ConversationMessage[]; reachedStart: boolean } | null>;
  endConversation(id: string): Promise<void>;
  /** 結果を人間の言葉にしたもの（`alteroid interrupt` と同じ文言）。 */
  interrupt(): Promise<string>;
  headerCounts(): Promise<HeaderCounts>;
  listManagers(query: ManagerListQuery): Promise<{
    managers: ManagerRow[];
    unreadable: UnreadableManager[];
  }>;
  /** `null` は 404（居ない）。読めない行（409）は `ApiError`。 */
  readManager(id: string): Promise<ManagerRow | null>;
  /** 生ログ（JSONL の生テキスト）。`null` は 404（まだ無い）。 */
  readManagerTranscript(id: string): Promise<string | null>;
  /** 追加指示（`requestId` / `decision` は付けない — 回答として消費させない）。 */
  sendManagerMessage(id: string, text: string): Promise<ManagerActionResult>;
  stopManager(id: string): Promise<ManagerActionResult>;
  /**
   * `GET /journal/stream`。接続できたとき `open`、以後は届いたエントリ（種別と本体）を流す。
   * ヘッダの件数と日誌のタブが、この 1 本を共有する（2 本目は張らない）。
   */
  journalStream(signal: AbortSignal): AsyncGenerator<JournalStreamItem>;
  /** `GET /journal`（新しい順）。 */
  listJournal(query: JournalListQuery): Promise<JournalListResult>;
  /** `GET /memory`。一覧はタイトルと要旨だけ（本文は詳細で読む）。 */
  listMemory(): Promise<MemoryRow[]>;
  /** `GET /memory/{slug}`。`null` は 404（無い）。 */
  readMemory(slug: string): Promise<MemoryDoc | null>;
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
      const body = await response.json();
      return { messages: body.messages, reachedStart: body.reachedStart };
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

    async listManagers(query) {
      const status = (query.status ?? []).join(',');
      const response = await client.managers.$get({
        query: {
          ...(status === '' ? {} : { status }),
          ...(query.limit === undefined ? {} : { limit: String(query.limit) }),
          ...(query.after === undefined
            ? {}
            : { afterId: query.after.managerId, afterStartedAt: query.after.startedAt }),
        },
      });
      if (!response.ok) throw await failure('委譲の一覧を読めませんでした', response);
      const body = await response.json();
      return {
        managers: body.managers as ManagerRow[],
        unreadable: (body.unreadable ?? []) as UnreadableManager[],
      };
    },

    async readManager(id) {
      const response = await client.managers[':id'].$get({ param: { id } });
      if (response.status === 404) return null;
      if (!response.ok) throw await failure('委譲を読めませんでした', response);
      return (await response.json()).manager as ManagerRow;
    },

    async readManagerTranscript(id) {
      const response = await client.managers[':id'].transcript.$get({ param: { id } });
      if (response.status === 404) return null;
      if (!response.ok) throw await failure('委譲の生ログを読めませんでした', response);
      return await response.text();
    },

    async sendManagerMessage(id, text) {
      const response = await client.managers[':id'].messages.$post({
        param: { id },
        json: { text },
      });
      if (response.status === 404) {
        throw new ApiError(`そのマネージャーは見つかりませんでした: ${id}`);
      }
      if (!response.ok) throw await failure('送れませんでした', response);
      const { outcome, detail } = await response.json();
      return { outcome, detail };
    },

    async stopManager(id) {
      const response = await client.managers[':id'].$delete({ param: { id }, json: {} });
      if (response.status === 404) {
        throw new ApiError(`そのマネージャーは見つかりませんでした: ${id}`);
      }
      if (!response.ok) throw await failure('止められませんでした', response);
      const { outcome, detail } = await response.json();
      return { outcome, detail };
    },

    async *journalStream(signal) {
      for await (const event of openStream(
        '/journal/stream',
        { method: 'GET' },
        '日誌の購読',
        signal,
      )) {
        yield {
          type: event.name,
          entry: event.name === 'open' ? null : event.json<JournalEntry>(),
        };
      }
    },

    async listJournal(query) {
      const type = (query.types ?? []).join(',');
      const response = await client.journal.$get({
        query: {
          limit: String(query.limit),
          ...(type === '' ? {} : { type }),
          ...(query.q === undefined || query.q === '' ? {} : { q: query.q }),
          ...(query.since === undefined ? {} : { since: query.since }),
          ...(query.until === undefined ? {} : { until: query.until }),
          ...(query.horizon === true ? { horizon: 'true' as const } : {}),
        },
      });
      if (!response.ok) throw await failure('日誌を読めませんでした', response);
      const body = await response.json();
      return {
        entries: body.entries as JournalEntry[],
        ...(body.oldestAt === undefined ? {} : { oldestAt: body.oldestAt }),
        ...(body.crossesHorizon === undefined ? {} : { crossesHorizon: body.crossesHorizon }),
      };
    },

    async listMemory() {
      const response = await client.memory.$get();
      if (!response.ok) throw await failure('記憶の一覧を読めませんでした', response);
      return (await response.json()).documents as MemoryRow[];
    },

    async readMemory(slug) {
      const response = await client.memory[':slug'].$get({ param: { slug } });
      if (response.status === 404) return null;
      if (!response.ok) throw await failure('記憶を読めませんでした', response);
      return (await response.json()).document as MemoryDoc;
    },
  };
}

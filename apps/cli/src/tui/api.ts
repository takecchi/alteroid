// SSE は hono/client ではなく生の fetch で受ける: hono/client では読めないため
import { randomUUID } from 'node:crypto';

import type {
  ApprovalQuestion,
  ApprovalSelection,
  AttachmentLimits,
  JournalEntry,
} from '@alteroid/core';

import {
  AttachmentMissingError,
  attachmentMissingMessageOf,
  fetchAttachmentLimits,
  uploadAttachment,
  type UploadedAttachment,
} from '../attachments.js';
import { createClient } from '../client.js';
import {
  fetchConversationApprovals,
  type ConversationApprovalsRead,
} from '../conversation-approvals.js';
import { withErrorReason } from '../format.js';
import type { MemorySummary } from '../memory.js';
import { describeAuthFailure, type Target } from '../target.js';
import { redactError } from '../redact.js';
import type { InterruptOutcome, InterruptTarget } from './interrupt-outcome.js';
import { readSSE } from './sse.js';

export type ChatEvent =
  | { type: 'open'; conversationId: string; inProgress?: boolean }
  | { type: 'queued' }
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: string }
  | { type: 'ask_human'; approvalId: string; question: string }
  | {
      type: 'attachments';
      attachments: { id: string; name: string; mediaType: string; size: number }[];
    }
  | { type: 'usage_limited'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface ConversationList {
  conversations: ConversationSummary[];
  scanned: number;
  reachedStart: boolean;
  hiddenByLimit: number;
  nextCursor?: string;
}

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
  role: 'inbound' | 'outbound';
  text: string;
  attachments?: { id: string; name: string; mediaType: string; size: number }[];
  supersededBy?: string;
  supersedes?: string;
}

export interface HeaderCounts {
  pendingApprovals: number;
  // `pendingApprovals` に足さない: 待っているとは限らないため
  unreadableApprovals: number;
  runningManagers: number;
}

export type ManagerStatus = 'running' | 'waiting_human' | 'done' | 'failed' | 'lost' | 'stopped';

export interface ManagerRow {
  managerId: string;
  status: ManagerStatus;
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
}

export interface UnreadableManager {
  id?: string;
  reason: string;
}

export interface ManagerListQuery {
  status?: readonly ManagerStatus[];
  limit?: number;
  after?: { managerId: string; startedAt: string };
}

export interface ManagerActionResult {
  outcome: string;
  detail: string;
}

export interface ApprovalRow {
  id: string;
  createdAt: string;
  question: string;
  context?: string;
  jobId?: string;
  conversationId?: string;
  answeredAt?: string;
  answer?: string;
  questions?: ApprovalQuestion[];
  selections?: ApprovalSelection[];
  withdrawnAt?: string;
  withdrawnReason?: string;
  permissionRequest?: { rule: string; allows: string[]; denies: string[] };
}

export interface AnsweredDateRow {
  date: string;
  count: number;
}

export interface UnreadableApproval {
  id?: string;
  reason: string;
}

export interface ApprovalAnswerBody {
  answer?: string;
  selections?: ApprovalSelection[];
}

export type MemoryRow = MemorySummary & { bytes?: number };

export interface MemoryDoc {
  slug: string;
  content: string;
  createdAt: MemorySummary['createdAt'];
  updatedAt: string;
}

export interface JournalListQuery {
  limit: number;
  types?: readonly string[];
  q?: string;
  since?: string;
  until?: string;
  afterId?: string;
  afterAt?: string;
  horizon?: boolean;
}

export interface JournalListResult {
  entries: JournalEntry[];
  next?: { id: string; at: string } | null;
  oldestAt?: string | null;
  crossesHorizon?: boolean;
}

export interface JournalStreamItem {
  type: string;
  entry: JournalEntry | null;
}

export interface TuiApi {
  readonly baseUrl: string;
  chat(
    input: {
      text: string;
      conversationId?: string;
      attachments?: string[];
      supersedes?: string;
      clientMessageId?: string;
    },
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent>;
  // 404 以外の失敗を `null` にしない: 「受け取っていない」と「確かめられなかった」を取り違えるため
  findClientMessage(clientMessageId: string): Promise<string | null>;
  attachmentLimits(): Promise<AttachmentLimits | null>;
  uploadAttachment(file: {
    name: string;
    mediaType: string;
    bytes: Uint8Array;
  }): Promise<UploadedAttachment>;
  listConversations(cursor?: string): Promise<ConversationList>;
  readConversation(
    id: string,
  ): Promise<{ messages: ConversationMessage[]; reachedStart: boolean } | null>;
  // 投げない: 会話の表示を落とさないため（取れなかったことは `failure` に載る）
  readConversationApprovals(id: string): Promise<ConversationApprovalsRead>;
  markConversationRead(id: string, through: string): Promise<void>;
  endConversation(id: string): Promise<void>;
  chatStream(conversationId: string, signal: AbortSignal): AsyncGenerator<ChatEvent>;
  // 対象を省くと種類を問わず走っているターンを止める: 対象の発言が無い（戻り接続で眺めているだけの）ときだけ省く
  interrupt(target?: InterruptTarget): Promise<InterruptOutcome>;
  headerCounts(): Promise<Partial<HeaderCounts>>;
  listManagers(query: ManagerListQuery): Promise<{
    managers: ManagerRow[];
    unreadable: UnreadableManager[];
  }>;
  readManager(id: string): Promise<ManagerRow | null>;
  readManagerTranscript(id: string): Promise<string | null>;
  // `requestId` / `decision` を付けない: 追加指示を回答として消費させないため
  sendManagerMessage(id: string, text: string): Promise<ManagerActionResult>;
  stopManager(id: string): Promise<ManagerActionResult>;
  listApprovals(query: { pending: boolean }): Promise<{
    approvals: ApprovalRow[];
    unreadable: UnreadableApproval[];
  }>;
  readApproval(id: string): Promise<ApprovalRow | null>;
  listAnsweredDates(query: { limit: number; beforeDate?: string }): Promise<AnsweredDateRow[]>;
  // 画面で並べ直さない: 並びはデーモンが決めるため
  listApprovalsAnsweredOn(date: string): Promise<ApprovalRow[]>;
  answerApproval(id: string, body: ApprovalAnswerBody): Promise<void>;
  // 2 本目を張らない: ヘッダの件数と日誌のタブが、この 1 本を共有するため
  journalStream(signal: AbortSignal): AsyncGenerator<JournalStreamItem>;
  listJournal(query: JournalListQuery): Promise<JournalListResult>;
  listMemory(): Promise<MemoryRow[]>;
  readMemory(slug: string): Promise<MemoryDoc | null>;
}

export class ApiError extends Error {}

// 2xx のあとで切れた失敗はこれにしない: 受け取られたか分からないため
export class NotDeliveredError extends ApiError {}

const CHAT_EVENT_NAMES = new Set([
  'open',
  'queued',
  'thinking',
  'text',
  'tool',
  'ask_human',
  'attachments',
  'usage_limited',
  'error',
  'done',
]);

export function createTuiApi(target: Target): TuiApi {
  const client = createClient(target.baseUrl, target.headers);

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
      throw new NotDeliveredError(
        `${what}: デーモンに繋がりません（${redactError(String(error))}）`,
      );
    }
    if (!response.ok || !response.body) {
      if (response.status === 400) {
        const missing = attachmentMissingMessageOf(
          await response
            .clone()
            .json()
            .catch(() => null),
        );
        if (missing !== null) throw new AttachmentMissingError(redactError(missing));
      }
      throw new NotDeliveredError((await failure(what, response)).message);
    }
    try {
      for await (const event of readSSE(response.body)) yield event;
    } catch (error) {
      if (signal.aborted) return;
      throw new ApiError(`${what}: 接続が切れました（${redactError(String(error))}）`);
    }
  }

  return {
    baseUrl: target.baseUrl,

    async *chat(input, signal) {
      const body = JSON.stringify({
        text: input.text,
        conversationId: input.conversationId ?? undefined,
        clientMessageId: input.clientMessageId ?? randomUUID(),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
        ...(input.attachments === undefined || input.attachments.length === 0
          ? {}
          : { attachments: input.attachments }),
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

    async findClientMessage(clientMessageId) {
      const response = await client['client-messages'][':clientMessageId'].$get({
        param: { clientMessageId },
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw await failure('前の送信が受け取られたか確かめられませんでした', response);
      }
      return (await response.json()).conversationId;
    },

    attachmentLimits() {
      return fetchAttachmentLimits(target);
    },

    uploadAttachment(file) {
      return uploadAttachment(target, file);
    },

    async *chatStream(conversationId, signal) {
      for await (const event of openStream(
        `/chat/${encodeURIComponent(conversationId)}/stream`,
        { method: 'GET' },
        '進行中の応答に戻れませんでした',
        signal,
      )) {
        if (!CHAT_EVENT_NAMES.has(event.name)) continue;
        const data = event.json<Record<string, unknown>>() ?? {};
        yield { ...data, type: event.name } as ChatEvent;
      }
    },

    async listConversations(cursor) {
      const response = await client.conversations.$get({
        query: cursor === undefined ? {} : { cursor },
      });
      if (!response.ok) throw await failure('会話の一覧を読めませんでした', response);
      const { conversations, scanned, reachedStart, hiddenByLimit, nextCursor } =
        await response.json();
      return {
        conversations,
        scanned,
        reachedStart,
        hiddenByLimit,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    },

    async readConversation(id) {
      const response = await client.conversations[':id'].$get({ param: { id }, query: {} });
      if (response.status === 404) return null;
      if (!response.ok) throw await failure('会話を読めませんでした', response);
      const body = await response.json();
      return { messages: body.messages, reachedStart: body.reachedStart };
    },

    readConversationApprovals(id) {
      return fetchConversationApprovals(client, id);
    },

    async markConversationRead(id, through) {
      const response = await client.conversations[':id'].read.$post({
        param: { id },
        json: { through },
      });
      if (!response.ok) throw await failure('既読にできませんでした', response);
    },

    async endConversation(id) {
      const response = await client.chat[':conversationId'].end.$post({
        param: { conversationId: id },
      });
      if (!response.ok) throw await failure('会話を終えられませんでした', response);
    },

    async interrupt(turn) {
      const response = await (turn === undefined
        ? client.clone.interrupt.$post()
        : client.clone.interrupt.$post({
            json: { conversationId: turn.conversationId, clientMessageId: turn.clientMessageId },
          }));
      if (!response.ok) throw await failure('クローンのターンを止められませんでした', response);
      return (await response.json()).outcome;
    },

    async headerCounts() {
      // `allSettled` を使う: 片方の失敗で他方の件数を捨てないため
      const [approvals, managers] = await Promise.allSettled([
        (async () => {
          const response = await client.approvals.$get({ query: {} });
          if (!response.ok) throw await failure('承認待ちを読めませんでした', response);
          const body = await response.json();
          return {
            pendingApprovals: body.approvals.length,
            unreadableApprovals: Array.isArray(body.unreadable) ? body.unreadable.length : 0,
          };
        })(),
        (async () => {
          // `limit` を足さない: 窓を当てると running の行が切られ、件数が欠けるため
          const response = await client.managers.$get({ query: { status: 'running' } });
          if (!response.ok) throw await failure('委譲を読めませんでした', response);
          return { runningManagers: (await response.json()).managers.length };
        })(),
      ]);
      if (approvals.status === 'rejected' && managers.status === 'rejected') {
        throw approvals.reason;
      }
      return {
        ...(approvals.status === 'fulfilled' ? approvals.value : {}),
        ...(managers.status === 'fulfilled' ? managers.value : {}),
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

    async listAnsweredDates(query) {
      const response = await client.approvals['answered-dates'].$get({
        query: {
          limit: String(query.limit),
          ...(query.beforeDate === undefined ? {} : { beforeDate: query.beforeDate }),
        },
      });
      if (!response.ok) throw await failure('承認が決着した日を読めませんでした', response);
      return (await response.json()).dates;
    },

    async listApprovalsAnsweredOn(date) {
      const response = await client.approvals.$get({ query: { answeredOn: date } });
      if (!response.ok) {
        throw await failure(`${date} に決着した承認を読めませんでした`, response);
      }
      return (await response.json()).approvals as ApprovalRow[];
    },

    async listApprovals(query) {
      const response = await client.approvals.$get({
        query: { order: 'asc', ...(query.pending ? {} : { pending: 'false' as const }) },
      });
      if (!response.ok) throw await failure('承認待ちを読めませんでした', response);
      const body = await response.json();
      return {
        approvals: body.approvals as ApprovalRow[],
        unreadable: (body.unreadable ?? []) as UnreadableApproval[],
      };
    },

    async readApproval(id) {
      const response = await client.approvals[':id'].$get({ param: { id } });
      if (response.status === 404) return null;
      if (!response.ok) throw await failure('承認を読めませんでした', response);
      return (await response.json()).approval as ApprovalRow;
    },

    async answerApproval(id, body) {
      const response = await client.approvals[':id'].answer.$post({ param: { id }, json: body });
      if (!response.ok) throw await failure('回答に失敗しました', response);
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
          ...(query.afterId === undefined || query.afterAt === undefined
            ? {}
            : { afterId: query.afterId, afterAt: query.afterAt }),
          ...(query.horizon === true ? { horizon: 'true' as const } : {}),
        },
      });
      if (!response.ok) throw await failure('日誌を読めませんでした', response);
      const body = await response.json();
      return {
        entries: body.entries as JournalEntry[],
        ...(body.next === undefined ? {} : { next: body.next }),
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

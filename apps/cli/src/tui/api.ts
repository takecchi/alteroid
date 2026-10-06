/**
 * TUI が使うデーモンの口。**新しい経路は 1 つも足さない** — Web UI と既存 CLI が使っている
 * 経路を、既存の `resolveTarget()`（接続・認証）と `createClient()`（hono/client）の上から
 * 呼ぶだけである。SSE（`POST /chat` と `GET /journal/stream`）は hono/client では読めない
 * ので、既存 CLI の `chat.ts` と同じく生の fetch で受ける（認証ヘッダはそこにも要る）。
 *
 * 画面（`chat-controller.ts` / `app.tsx`）はこの `TuiApi` インターフェースだけを見る。
 * 試験では偽物を渡す。
 */
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
import { describeInterruptOutcome } from '../interrupt.js';
import type { MemorySummary } from '../memory.js';
import { describeAuthFailure, type Target } from '../target.js';
import { redactError } from '../redact.js';
import { readSSE } from './sse.js';

/** `POST /chat` の SSE イベント（`apps/daemon/src/app.ts` の `/chat`。Web と同じ語彙）。 */
export type ChatEvent =
  /** `inProgress` は `GET /chat/{id}/stream` だけが付ける（進行中のターンがあるか）。 */
  | { type: 'open'; conversationId: string; inProgress?: boolean }
  | { type: 'queued' }
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: string }
  | { type: 'ask_human'; approvalId: string; question: string }
  | { type: 'usage_limited'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** `GET /conversations` の応答のうち、画面が使う欄（既存の CLI の `conversations` と同じ）。 */
export interface ConversationList {
  conversations: ConversationSummary[];
  scanned: number;
  reachedStart: boolean;
  hiddenByLimit: number;
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
  /** `inbound` = 人間の発言 / `outbound` = クローンの返答。 */
  role: 'inbound' | 'outbound';
  text: string;
  /** 発言に添えた添付のメタデータ（中身は無い）。 */
  attachments?: { id: string; name: string; mediaType: string; size: number }[];
}

export interface HeaderCounts {
  /** 未回答の承認待ち。読めない行（`unreadable`）は数えない。 */
  pendingApprovals: number;
  /**
   * 読めない承認待ちの行数（`unreadable`）。`pendingApprovals` には足さない（待っているとは限らない）
   * が、0 件の顔にもしない — ヘッダとタブが警告で言う（#3090）。古いデーモンが返さなければ 0。
   */
  unreadableApprovals: number;
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
  /** 置き先の runner が名乗ったマネージャー層の provider。欄が無いのは「不明」（claude と推測しない。#486 S9）。 */
  managerProvider?: string;
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

/**
 * 承認待ち 1 件（`GET /approvals` の `pendingApprovalSchema` のうち TUI が使う欄だけ）。
 * `request_permission` の承認待ちには `questions` が無く、`permissionRequest` が付く。
 */
export interface ApprovalRow {
  id: string;
  createdAt: string;
  question: string;
  context?: string;
  /** どのマネージャーの件か。無ければクローン自身の確認。 */
  jobId?: string;
  conversationId?: string;
  answeredAt?: string;
  /** `selections` で答えたときは、デーモンが畳んだ文。 */
  answer?: string;
  questions?: ApprovalQuestion[];
  selections?: ApprovalSelection[];
  withdrawnAt?: string;
  withdrawnReason?: string;
  permissionRequest?: { rule: string; allows: string[]; denies: string[] };
}

/** 読めない承認待ちの行（壊れた行。「無い」でも「回答済み」でもない）。 */
export interface UnreadableApproval {
  id?: string;
  reason: string;
}

/** `POST /approvals/{id}/answer` の本文。どちらか一方は要る（`selections` があれば `answer` は補足）。 */
export interface ApprovalAnswerBody {
  answer?: string;
  selections?: ApprovalSelection[];
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
  /** 頁の継続点（`GET /journal` の `next`）。組で渡す。 */
  afterId?: string;
  afterAt?: string;
  /** 絞らずに日誌の地平（`oldestAt` / `crossesHorizon`）も欲しいとき。 */
  horizon?: boolean;
}

export interface JournalListResult {
  /** 新しい順。 */
  entries: JournalEntry[];
  /** 次の頁の継続点。`null` = 本当の終端。`undefined` = 欄が無い（古いデーモン）。 */
  next?: { id: string; at: string } | null;
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
    input: {
      text: string;
      conversationId?: string;
      attachments?: string[];
      /** 呼び手が名乗らせたいとき（`open` の前に終わった送信を、あとで引き直す。#3304）。無ければ api が採番する。 */
      clientMessageId?: string;
    },
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent>;
  /**
   * `GET /client-messages/{clientMessageId}`（#3304）。受け取り済みならその会話の id、**受け取っていなければ
   * （404）`null`**。それ以外の失敗は `ApiError` を投げる（「受け取っていない」と「確かめられなかった」を取り違えない）。
   */
  findClientMessage(clientMessageId: string): Promise<string | null>;
  /** `GET /attachments/limits`。古いデーモン（404）は既定値、一時的な失敗は `null`（失敗は投げない）。 */
  attachmentLimits(): Promise<AttachmentLimits | null>;
  /** `POST /attachments`（生のバイト列）。失敗は `ApiError` ではなく普通の `Error`（理由つき）。 */
  uploadAttachment(file: {
    name: string;
    mediaType: string;
    bytes: Uint8Array;
  }): Promise<UploadedAttachment>;
  /**
   * 履歴の一覧。`reachedStart` が偽なら、窓（`scanned` 件の往復）の外に古い会話が残っているかもしれない
   * （一覧が空でも「無い」とは言えない）。`hiddenByLimit` は窓の中で上限に収まらず省いた会話の数。
   */
  listConversations(): Promise<ConversationList>;
  /**
   * `null` は 404（遡り切れた上で「無い」）。`reachedStart` が偽なら、窓の外に続き（古い発言）が
   * 残っているかもしれない。`messages` が空でこれが偽のときは「無い」ではなく**判定できない**。
   */
  readConversation(
    id: string,
  ): Promise<{ messages: ConversationMessage[]; reachedStart: boolean } | null>;
  /**
   * その会話のターンから積まれた承認待ち（`GET /approvals?conversationId=<id>&pending=false&order=asc`）。
   * **投げない**——取れなかったことは `failure` に載る（会話の表示を落とさない。#3261）。
   */
  readConversationApprovals(id: string): Promise<ConversationApprovalsRead>;
  /**
   * `POST /conversations/{id}/read`。`through` は発言の id（時刻はサーバが引く）。失敗は `ApiError`。
   * 返答を画面に表示したときに呼ぶ（`docs/architecture.md`「会話の既読」）。
   */
  markConversationRead(id: string, through: string): Promise<void>;
  endConversation(id: string): Promise<void>;
  /**
   * `GET /chat/{id}/stream`。進行中のターンの途中経過に戻る（発言は投函しない）。最初に
   * `open`（`inProgress` つき）が来る。進行中ならそれまでの出来事を順に流してから続きを流し、
   * `done` / `error` で閉じる。進行中でなければ `open` だけで閉じる。
   */
  chatStream(conversationId: string, signal: AbortSignal): AsyncGenerator<ChatEvent>;
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
  /** `GET /approvals?order=asc`。`pending: true` なら未回答かつ未取り下げのみ。 */
  listApprovals(query: { pending: boolean }): Promise<{
    approvals: ApprovalRow[];
    unreadable: UnreadableApproval[];
  }>;
  /**
   * `POST /approvals/{id}/answer`。失敗（400 の理由・404・409）は `ApiError`。メッセージにデーモンの
   * 理由（本文の `error`）がそのまま入る。
   */
  answerApproval(id: string, body: ApprovalAnswerBody): Promise<void>;
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
      throw new ApiError(`${what}: デーモンに繋がりません（${redactError(String(error))}）`);
    }
    if (!response.ok || !response.body) {
      // 添付が無い・期限切れ（400 の `code`）は、呼び手が上げ直せるよう型で渡す（#3246）。
      if (response.status === 400) {
        const missing = attachmentMissingMessageOf(
          await response
            .clone()
            .json()
            .catch(() => null),
        );
        if (missing !== null) throw new AttachmentMissingError(redactError(missing));
      }
      throw await failure(what, response);
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
        // 発言ごとに名乗る（Issue #3203）。新しい会話で `open` の前に終わった送信は、呼び手がこの id で引き直す（#3304）。
        clientMessageId: input.clientMessageId ?? randomUUID(),
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

    async listConversations() {
      const response = await client.conversations.$get({ query: {} });
      if (!response.ok) throw await failure('会話の一覧を読めませんでした', response);
      const { conversations, scanned, reachedStart, hiddenByLimit } = await response.json();
      return { conversations, scanned, reachedStart, hiddenByLimit };
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
      const approvalsBody = await approvals.json();
      return {
        pendingApprovals: approvalsBody.approvals.length,
        unreadableApprovals: Array.isArray(approvalsBody.unreadable)
          ? approvalsBody.unreadable.length
          : 0,
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

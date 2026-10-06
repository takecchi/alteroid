/**
 * 試験用の偽の `TuiApi`。`chat()` は呼び出しごとに「台本」（イベント列）を 1 つ消費し、
 * 台本の途中に `Promise` を置くと、そこで止まって試験が好きな時に再開できる。
 */
import {
  describeSelectionsViolation,
  foldSelections,
  matchesJournalSearch,
} from '@alteroid/core/cli-light';
import {
  DEFAULT_ATTACHMENT_LIMITS,
  type AttachmentLimits,
  type JournalEntry,
} from '@alteroid/core';

import type { ConversationApprovalsRead } from '../conversation-approvals.js';
import { ApiError } from './api.js';
import type {
  ApprovalAnswerBody,
  AnsweredDateRow,
  ApprovalRow,
  UnreadableApproval,
  ChatEvent,
  ConversationMessage,
  ConversationSummary,
  HeaderCounts,
  JournalListQuery,
  JournalStreamItem,
  ManagerListQuery,
  ManagerRow,
  MemoryDoc,
  MemoryRow,
  TuiApi,
  UnreadableManager,
} from './api.js';

export type ScriptStep = ChatEvent | Promise<void> | Error;

export interface ChatCall {
  text: string;
  conversationId?: string;
  attachments?: string[];
  supersedes?: string;
}

export interface FakeApi extends TuiApi {
  chatCalls: ChatCall[];
  /** `chat()` に渡された `clientMessageId`（`chatCalls` と同じ順）。 */
  chatClientMessageIds: (string | undefined)[];
  /** サーバが受け取り済みの発言（`clientMessageId` → 会話 id）。`findClientMessage` が引く。 */
  receivedClientMessages: Record<string, string>;
  /** `findClientMessage` に渡された id。 */
  clientMessageLookups: string[];
  /** 非 null なら `findClientMessage` がこの理由で失敗する。 */
  clientMessageLookupFails: string | null;
  /** `uploadAttachment()` に渡されたもの。 */
  uploads: { name: string; mediaType: string; size: number }[];
  /** 次の（以降の）`uploadAttachment()` を失敗させる理由。 */
  uploadFails: string | null;
  /** `attachmentLimits()` が返す上限（既定は core の既定値）。 */
  limits: AttachmentLimits | null;
  /** `attachmentLimits()` が呼ばれた回数。 */
  limitsCalls: number;
  scripts: ScriptStep[][];
  /** `chatStream()` の台本（呼び出しごとに 1 つ消費する。足りなければ空）。 */
  streamScripts: ScriptStep[][];
  /** `chatStream()` に渡された会話 id と、その接続が abort されたか。 */
  streamCalls: { conversationId: string; aborted: () => boolean }[];
  ended: string[];
  /** `markConversationRead` の呼び出し（会話 id と `through`）。 */
  readMarks: { id: string; through: string }[];
  /** 非 null なら `markConversationRead` がこの理由で失敗する。 */
  readMarkFails: string | null;
  interrupts: number;
  /** 非 null なら `interrupt()` がこの理由で失敗する。 */
  interruptFails: string | null;
  conversations: ConversationSummary[];
  /**
   * 非 null なら `listConversations` が頁で返す（`nextCursor` は `page-N`、最後の頁は無し。#3643）。
   * null なら `conversations` を 1 頁で全部返す（従来）。
   */
  conversationPages: ConversationSummary[][] | null;
  /** 非 null なら、継続点つきの `listConversations` がこの理由で失敗する。 */
  conversationPageFails: string | null;
  /** 非 null なら、継続点つきの `listConversations` はこれが解けるまで返らない。 */
  conversationPageGate: Promise<void> | null;
  /** `listConversations` に渡された継続点（1 頁目は undefined）。 */
  listCursors: (string | undefined)[];
  messages: Record<string, ConversationMessage[]>;
  /** 窓が日誌の先頭に届いていない会話の id。 */
  unreachedStart: Set<string>;
  /** 会話ごとの、その会話のターンから積まれた承認（`readConversationApprovals` が返す）。 */
  conversationApprovals: Record<string, ConversationApprovalsRead>;
  /** `readConversationApprovals` に渡された会話 id。 */
  conversationApprovalCalls: string[];
  counts: HeaderCounts;
  /** 1 本目 = 最初の接続の台本。文字列は種別だけ（本体なし）、オブジェクトは本体つき。 */
  journal: { events: (string | JournalStreamItem | Error | Promise<void>)[] }[];
  /** 新しい順（`at` 降順）の日誌。`GET /journal` はこれを絞って返す。 */
  journalEntries: JournalEntry[];
  journalListCalls: JournalListQuery[];
  /** 次の `listJournal` を失敗させる。 */
  journalListFails: string | null;
  /** `GET /journal` の応答に載せる地平。 */
  journalHorizon: { oldestAt?: string | null; crossesHorizon?: boolean };
  /**
   * `true` なら新しいデーモンのように継続点（`next`）を返す。`journalEntries` のうち
   * `journalUnreadable` の id は、pg と同じく `limit` の後で捨てる（頁は短く・空になりうる）。
   * `false`（既定）は `next` を返さない古いデーモン。
   */
  journalCursors: boolean;
  journalUnreadable: Set<string>;
  memoryRows: MemoryRow[];
  memoryDocs: Record<string, MemoryDoc>;
  memoryListFails: string | null;
  readMemoryCalls: string[];
  endFails: boolean;
  /** 新しい順（`startedAt` 降順）の委譲。 */
  managerRows: ManagerRow[];
  unreadableManagers: UnreadableManager[];
  managerListCalls: ManagerListQuery[];
  /** id → 生ログ（JSONL）。無ければ 404 相当（`null`）。 */
  transcripts: Record<string, string>;
  managerMessages: { id: string; text: string }[];
  stoppedManagers: string[];
  /** 次の `listManagers` を失敗させる。 */
  managerListFails: string | null;
  stopResult: { outcome: string; detail: string };
  /** 古い順（`createdAt` 昇順）の承認待ち。回答すると回答済みになり、未回答の一覧から消える。 */
  approvalRows: ApprovalRow[];
  unreadableApprovals: UnreadableApproval[];
  approvalListCalls: { pending: boolean }[];
  /** `readApproval`（id で1件）に渡された id。 */
  approvalReadCalls: string[];
  /** 次の `readApproval` を失敗させる。 */
  approvalReadFails: string | null;
  /** 新しい日が上の「決着した日と件数」（`listAnsweredDates` が返す）。 */
  answeredDateRows: AnsweredDateRow[];
  answeredDateCalls: { limit: number; beforeDate?: string }[];
  /** 次の `listAnsweredDates` を失敗させる。 */
  answeredDatesFail: string | null;
  /** 日付 → その日の件（決着の新しい順。デーモンが並べた形で渡す）。無い日は空。 */
  answeredOnRows: Record<string, ApprovalRow[]>;
  answeredOnCalls: string[];
  /** 次の `listApprovalsAnsweredOn` を失敗させる。 */
  answeredOnFail: string | null;
  /** 次の `listApprovals` を失敗させる。 */
  approvalListFails: string | null;
  /** 受け取った回答（デーモンへ届いた本文そのまま）。 */
  approvalAnswers: { id: string; body: ApprovalAnswerBody }[];
  /** 次の `answerApproval` を、この理由で失敗させる（デーモンが 400 などで返す本文の想定）。 */
  approvalAnswerFails: string | null;
}

/** 試験用の承認待ち 1 件。 */
export function approvalRow(id: string, patch: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id,
    createdAt: '2026-10-02T00:00:00.000Z',
    question: `${id} の質問`,
    ...patch,
  };
}

/** 試験用のマネージャー 1 本。 */
export function managerRow(id: string, patch: Partial<ManagerRow> = {}): ManagerRow {
  return {
    managerId: id,
    status: 'running',
    live: true,
    request: `${id} の依頼`,
    cwd: '/work',
    startedAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    waiting: [],
    ...patch,
  };
}

export function fakeApi(): FakeApi {
  const api: FakeApi = {
    baseUrl: 'http://127.0.0.1:4517',
    chatCalls: [],
    chatClientMessageIds: [],
    receivedClientMessages: {},
    clientMessageLookups: [],
    clientMessageLookupFails: null,
    scripts: [],
    streamScripts: [],
    streamCalls: [],
    ended: [],
    readMarks: [],
    readMarkFails: null,
    interrupts: 0,
    interruptFails: null,
    conversations: [],
    conversationPages: null,
    conversationPageFails: null,
    conversationPageGate: null,
    listCursors: [],
    messages: {},
    unreachedStart: new Set(),
    conversationApprovals: {},
    conversationApprovalCalls: [],
    counts: { pendingApprovals: 0, unreadableApprovals: 0, runningManagers: 0 },
    journal: [],
    journalEntries: [],
    journalListCalls: [],
    journalListFails: null,
    journalHorizon: {},
    journalCursors: false,
    journalUnreadable: new Set<string>(),
    memoryRows: [],
    memoryDocs: {},
    memoryListFails: null,
    readMemoryCalls: [],
    endFails: false,
    managerRows: [],
    unreadableManagers: [],
    managerListCalls: [],
    transcripts: {},
    managerMessages: [],
    stoppedManagers: [],
    managerListFails: null,
    stopResult: { outcome: 'stopped', detail: '止まったと確かめた。' },
    approvalRows: [],
    unreadableApprovals: [],
    approvalListCalls: [],
    approvalReadCalls: [],
    approvalReadFails: null,
    answeredDateRows: [],
    answeredDateCalls: [],
    answeredDatesFail: null,
    answeredOnRows: {},
    answeredOnCalls: [],
    answeredOnFail: null,
    approvalListFails: null,
    approvalAnswers: [],
    approvalAnswerFails: null,
    uploads: [],
    uploadFails: null,
    limits: DEFAULT_ATTACHMENT_LIMITS,
    limitsCalls: 0,
    async attachmentLimits() {
      api.limitsCalls += 1;
      return api.limits;
    },
    findClientMessage(clientMessageId) {
      api.clientMessageLookups.push(clientMessageId);
      if (api.clientMessageLookupFails !== null) {
        return Promise.reject(new ApiError(api.clientMessageLookupFails));
      }
      return Promise.resolve(api.receivedClientMessages[clientMessageId] ?? null);
    },
    async *chat(input, signal) {
      api.chatClientMessageIds.push(input.clientMessageId);
      api.chatCalls.push({
        text: input.text,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      });
      const script = api.scripts.shift() ?? [];
      for (const step of script) {
        if (signal.aborted) return;
        if (step instanceof Error) throw step;
        if (step instanceof Promise) {
          await step;
          continue;
        }
        yield step;
      }
    },
    async uploadAttachment(file) {
      api.uploads.push({ name: file.name, mediaType: file.mediaType, size: file.bytes.length });
      if (api.uploadFails !== null) throw new Error(api.uploadFails);
      const id = `att-${api.uploads.length}`;
      return {
        id,
        name: file.name,
        mediaType: file.mediaType,
        size: file.bytes.length,
        sha256: 'x',
      };
    },
    async *chatStream(conversationId, signal) {
      api.streamCalls.push({ conversationId, aborted: () => signal.aborted });
      const script = api.streamScripts.shift() ?? [];
      for (const step of script) {
        if (signal.aborted) return;
        if (step instanceof Error) throw step;
        if (step instanceof Promise) {
          await step;
          continue;
        }
        yield step;
      }
    },
    async listConversations(cursor) {
      api.listCursors.push(cursor);
      if (cursor !== undefined) {
        // 「もっと見る」の頁だけ、失敗と待ちを差し込める（実時間の待ちを書かないため）。
        if (api.conversationPageGate !== null) await api.conversationPageGate;
        if (api.conversationPageFails !== null) throw new Error(api.conversationPageFails);
      }
      // `conversationPages` が在れば継続点（`page-N`）で頁を引く。無ければ従来どおり 1 頁で全部。
      const pages = api.conversationPages;
      if (pages !== null) {
        const index = cursor === undefined ? 0 : Number(cursor.replace('page-', ''));
        const page = pages[index] ?? [];
        return {
          conversations: page,
          scanned: page.length,
          reachedStart: index + 1 >= pages.length,
          hiddenByLimit: 0,
          ...(index + 1 < pages.length ? { nextCursor: `page-${String(index + 1)}` } : {}),
        };
      }
      return await Promise.resolve({
        conversations: api.conversations,
        scanned: api.conversations.length,
        reachedStart: true,
        hiddenByLimit: 0,
      });
    },
    readConversation(id) {
      const messages = api.messages[id];
      return Promise.resolve(
        messages === undefined ? null : { messages, reachedStart: !api.unreachedStart.has(id) },
      );
    },
    readConversationApprovals(id) {
      api.conversationApprovalCalls.push(id);
      return Promise.resolve(api.conversationApprovals[id] ?? { approvals: [], unreadable: [] });
    },
    markConversationRead(id, through) {
      api.readMarks.push({ id, through });
      return api.readMarkFails === null
        ? Promise.resolve()
        : Promise.reject(new Error(api.readMarkFails));
    },
    endConversation(id) {
      api.ended.push(id);
      return api.endFails ? Promise.reject(new Error('終えられない')) : Promise.resolve();
    },
    interrupt() {
      api.interrupts += 1;
      if (api.interruptFails !== null) return Promise.reject(new Error(api.interruptFails));
      return Promise.resolve('いま走っていたクローンのターンを止めた。');
    },
    listManagers(query) {
      api.managerListCalls.push(query);
      if (api.managerListFails !== null) return Promise.reject(new Error(api.managerListFails));
      let rows = api.managerRows;
      if (query.status !== undefined && query.status.length > 0) {
        rows = rows.filter((row) => query.status?.includes(row.status));
      }
      if (query.after !== undefined) {
        const at = rows.findIndex((row) => row.managerId === query.after?.managerId);
        if (at < 0) return Promise.reject(new Error('錨が指す行が見当たらない'));
        rows = rows.slice(at + 1);
      }
      if (query.limit !== undefined) rows = rows.slice(0, query.limit);
      return Promise.resolve({ managers: rows, unreadable: api.unreadableManagers });
    },
    readManager(id) {
      return Promise.resolve(api.managerRows.find((row) => row.managerId === id) ?? null);
    },
    readManagerTranscript(id) {
      return Promise.resolve(api.transcripts[id] ?? null);
    },
    sendManagerMessage(id, text) {
      api.managerMessages.push({ id, text });
      return Promise.resolve({ outcome: 'delivered', detail: '追加指示として届けた。' });
    },
    stopManager(id) {
      api.stoppedManagers.push(id);
      return Promise.resolve(api.stopResult);
    },
    headerCounts() {
      return Promise.resolve(api.counts);
    },
    listApprovals(query) {
      api.approvalListCalls.push(query);
      if (api.approvalListFails !== null) return Promise.reject(new Error(api.approvalListFails));
      const rows = query.pending
        ? api.approvalRows.filter((r) => r.answeredAt === undefined && r.withdrawnAt === undefined)
        : api.approvalRows;
      return Promise.resolve({ approvals: rows, unreadable: api.unreadableApprovals });
    },
    readApproval(id) {
      api.approvalReadCalls.push(id);
      if (api.approvalReadFails !== null) return Promise.reject(new Error(api.approvalReadFails));
      return Promise.resolve(api.approvalRows.find((r) => r.id === id) ?? null);
    },
    listAnsweredDates(query) {
      api.answeredDateCalls.push(query);
      if (api.answeredDatesFail !== null) return Promise.reject(new Error(api.answeredDatesFail));
      const older = api.answeredDateRows.filter(
        (r) => query.beforeDate === undefined || r.date < query.beforeDate,
      );
      return Promise.resolve(older.slice(0, query.limit));
    },
    listApprovalsAnsweredOn(date) {
      api.answeredOnCalls.push(date);
      if (api.answeredOnFail !== null) return Promise.reject(new Error(api.answeredOnFail));
      return Promise.resolve(api.answeredOnRows[date] ?? []);
    },
    answerApproval(id, body) {
      api.approvalAnswers.push({ id, body });
      if (api.approvalAnswerFails !== null) {
        return Promise.reject(
          new ApiError(`回答に失敗しました（HTTP 400）: ${api.approvalAnswerFails}`),
        );
      }
      const row = api.approvalRows.find((r) => r.id === id);
      if (row === undefined)
        return Promise.reject(new ApiError('回答に失敗しました（HTTP 404）: not found'));
      if (row.answeredAt !== undefined) {
        return Promise.reject(new ApiError('回答に失敗しました（HTTP 409）: already answered'));
      }
      // デーモンと同じ検査と畳み方（`POST /approvals/:id/answer`）。
      if (body.selections !== undefined) {
        const violation = describeSelectionsViolation(row.questions, body.selections, body.answer);
        if (violation !== null) {
          return Promise.reject(
            new ApiError(`回答に失敗しました（HTTP 400）: selections が不正: ${violation}`),
          );
        }
      }
      row.answeredAt = new Date().toISOString();
      row.answer =
        body.selections !== undefined && row.questions !== undefined
          ? foldSelections(row.questions, body.selections, body.answer)
          : (body.answer ?? '');
      if (body.selections !== undefined) row.selections = body.selections;
      return Promise.resolve();
    },
    async *journalStream(signal) {
      const stream = api.journal.shift();
      if (stream === undefined) {
        // 台本が無ければ繋がったまま黙る（中断されるまで待つ）。
        yield { type: 'open', entry: null };
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      for (const event of stream.events) {
        if (event instanceof Error) throw event;
        if (event instanceof Promise) {
          await event;
          continue;
        }
        yield typeof event === 'string' ? { type: event, entry: null } : event;
      }
    },
    listJournal(query) {
      api.journalListCalls.push(query);
      if (api.journalListFails !== null) return Promise.reject(new Error(api.journalListFails));
      let rows = api.journalEntries;
      const types = query.types ?? [];
      if (types.length > 0) rows = rows.filter((e) => types.includes(e.type));
      if (query.q !== undefined && query.q !== '') {
        const q = query.q;
        rows = rows.filter((e) => matchesJournalSearch(e, q));
      }
      // `since` / `until` は inclusive（デーモンと同じ）。
      if (query.since !== undefined) {
        const since = query.since;
        rows = rows.filter((e) => e.at >= since);
      }
      if (query.until !== undefined) {
        const until = query.until;
        rows = rows.filter((e) => e.at <= until);
      }
      if (api.journalCursors) {
        // 新しいデーモン: 生の頁を `limit` で切り、その後で読めない行を捨てる。
        if (query.afterId !== undefined) {
          const afterId = query.afterId;
          rows = rows.slice(rows.findIndex((e) => e.id === afterId) + 1);
        }
        const raw = rows.slice(0, query.limit);
        const last = raw[raw.length - 1];
        return Promise.resolve({
          entries: raw.filter((e) => !api.journalUnreadable.has(e.id)),
          next:
            rows.length > query.limit && last !== undefined ? { id: last.id, at: last.at } : null,
          ...(query.horizon === true || query.since !== undefined || query.until !== undefined
            ? api.journalHorizon
            : {}),
        });
      }
      return Promise.resolve({
        entries: rows.slice(0, query.limit),
        ...(query.horizon === true || query.since !== undefined || query.until !== undefined
          ? api.journalHorizon
          : {}),
      });
    },
    listMemory() {
      if (api.memoryListFails !== null) return Promise.reject(new Error(api.memoryListFails));
      return Promise.resolve(api.memoryRows);
    },
    readMemory(slug) {
      api.readMemoryCalls.push(slug);
      return Promise.resolve(api.memoryDocs[slug] ?? null);
    },
  };
  return api;
}

/** 外から解放できる待ち。 */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** 試験用の日誌 1 件（`type` ごとに必要な欄は `extra` で足す。形の検査はしない）。 */
export function journalEntry(
  id: string,
  type: JournalEntry['type'],
  at: string,
  extra: Record<string, unknown> = {},
): JournalEntry {
  return { id, at, type, ...extra } as unknown as JournalEntry;
}

/** `n` 分目の ISO 時刻（`n` が大きいほど新しい）。 */
export function minute(n: number): string {
  return new Date(Date.UTC(2026, 9, 2, 0, n)).toISOString();
}

/** 人間との発言（`exchange`）。 */
export function said(n: number, text = `発言${String(n)}`): JournalEntry {
  return journalEntry(`e${String(n)}`, 'exchange', minute(n), {
    with: 'human',
    role: 'inbound',
    text,
  });
}

/** 試験用の記憶 1 件（一覧の行）。 */
export function memoryRow(slug: string, patch: Partial<MemoryRow> = {}): MemoryRow {
  return {
    slug,
    title: `${slug} のタイトル`,
    kind: 'fact',
    description: `${slug} の要旨`,
    descriptionFreshness: { kind: 'fresh' },
    updatedAt: '2026-10-02T00:00:00.000Z',
    createdAt: { kind: 'known', at: '2026-10-01T00:00:00.000Z' },
    bytes: 2048,
    ...patch,
  };
}

/** 試験用の記憶 1 件（詳細）。 */
export function memoryDoc(slug: string, content: string): MemoryDoc {
  return {
    slug,
    content,
    createdAt: { kind: 'known', at: '2026-10-01T00:00:00.000Z' },
    updatedAt: '2026-10-02T00:00:00.000Z',
  };
}

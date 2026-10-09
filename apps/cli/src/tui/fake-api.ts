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
import { attachmentNotFoundMessage } from '../attachments.js';
import { ApiError, type StoredAttachment } from './api.js';
import type { InterruptOutcome, InterruptTarget } from './interrupt-outcome.js';
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
  chatClientMessageIds: (string | undefined)[];
  receivedClientMessages: Record<string, string>;
  clientMessageLookups: string[];
  clientMessageLookupFails: string | null;
  uploads: { name: string; mediaType: string; size: number }[];
  uploadFails: string | null;
  uploadSignals: (AbortSignal | undefined)[];
  limits: AttachmentLimits | null;
  limitsCalls: number;
  // 置き場（#4126）。`storedAttachments` は新しい順の全件。`storedPageSize` で頁に切る
  storedAttachments: StoredAttachment[];
  storedPageSize: number;
  storedListCalls: { kept?: boolean; cursor?: string }[];
  storedKeepCalls: { id: string; kept: boolean }[];
  storedRemoveCalls: string[];
  storedFails: string | null;
  scripts: ScriptStep[][];
  streamScripts: ScriptStep[][];
  streamCalls: { conversationId: string; aborted: () => boolean }[];
  ended: string[];
  readMarks: { id: string; through: string }[];
  readMarkFails: string | null;
  interrupts: number;
  interruptTargets: (InterruptTarget | undefined)[];
  interruptOutcome: InterruptOutcome;
  interruptFails: string | null;
  conversations: ConversationSummary[];
  conversationPages: ConversationSummary[][] | null;
  conversationPageFails: string | null;
  conversationPageGate: Promise<void> | null;
  listCursors: (string | undefined)[];
  messages: Record<string, ConversationMessage[]>;
  unreachedStart: Set<string>;
  conversationApprovals: Record<string, ConversationApprovalsRead>;
  conversationApprovalCalls: string[];
  counts: HeaderCounts;
  journal: { events: (string | JournalStreamItem | Error | Promise<void>)[] }[];
  journalEntries: JournalEntry[];
  journalListCalls: JournalListQuery[];
  journalListFails: string | null;
  journalHorizon: { oldestAt?: string | null; crossesHorizon?: boolean };
  journalCursors: boolean;
  journalUnreadable: Set<string>;
  memoryRows: MemoryRow[];
  memoryDocs: Record<string, MemoryDoc>;
  memoryListFails: string | null;
  readMemoryCalls: string[];
  endFails: boolean;
  managerRows: ManagerRow[];
  unreadableManagers: UnreadableManager[];
  managerListCalls: ManagerListQuery[];
  transcripts: Record<string, string>;
  managerMessages: { id: string; text: string }[];
  stoppedManagers: string[];
  managerListFails: string | null;
  stopResult: { outcome: string; detail: string };
  approvalRows: ApprovalRow[];
  unreadableApprovals: UnreadableApproval[];
  approvalListCalls: { pending: boolean }[];
  approvalReadCalls: string[];
  approvalReadFails: string | null;
  answeredDateRows: AnsweredDateRow[];
  answeredDateCalls: { limit: number; beforeDate?: string }[];
  answeredDatesFail: string | null;
  answeredOnRows: Record<string, ApprovalRow[]>;
  answeredOnCalls: string[];
  answeredOnFail: string | null;
  approvalListFails: string | null;
  approvalAnswers: { id: string; body: ApprovalAnswerBody }[];
  approvalAnswerFails: string | null;
}

export function approvalRow(id: string, patch: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id,
    createdAt: '2026-10-02T00:00:00.000Z',
    question: `${id} の質問`,
    ...patch,
  };
}

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
    interruptTargets: [],
    interruptOutcome: 'interrupted',
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
    uploadSignals: [],
    limits: DEFAULT_ATTACHMENT_LIMITS,
    limitsCalls: 0,
    storedAttachments: [],
    storedPageSize: 100,
    storedListCalls: [],
    storedKeepCalls: [],
    storedRemoveCalls: [],
    storedFails: null,
    async attachmentLimits() {
      api.limitsCalls += 1;
      return api.limits;
    },
    async listStoredAttachments(query) {
      api.storedListCalls.push(query);
      if (api.storedFails !== null) throw new ApiError(api.storedFails);
      const all = api.storedAttachments.filter(
        (a) => query.kept === undefined || (a.keptAt !== undefined) === query.kept,
      );
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      const items = all.slice(start, start + api.storedPageSize);
      const bucket = (list: StoredAttachment[]) => ({
        count: list.length,
        totalBytes: list.reduce((sum, a) => sum + a.size, 0),
      });
      return {
        items,
        usage: {
          ...bucket(api.storedAttachments),
          byFrom: {
            human: bucket(api.storedAttachments.filter((a) => a.uploadedBy === 'human')),
          },
        },
        ...(start + items.length < all.length ? { nextCursor: String(start + items.length) } : {}),
      };
    },
    async keepAttachment(id, kept) {
      api.storedKeepCalls.push({ id, kept });
      if (api.storedFails !== null) throw new ApiError(api.storedFails);
      const found = api.storedAttachments.find((a) => a.id === id);
      if (found === undefined) throw new ApiError(attachmentNotFoundMessage(id));
      if (kept) {
        found.keptAt = '2026-10-09T00:00:00.000Z';
        delete found.expiresAt;
      } else {
        delete found.keptAt;
        found.expiresAt = '2026-11-08T00:00:00.000Z';
      }
      return { ...found };
    },
    async removeAttachment(id) {
      api.storedRemoveCalls.push(id);
      if (api.storedFails !== null) throw new ApiError(api.storedFails);
      const index = api.storedAttachments.findIndex((a) => a.id === id);
      if (index < 0) throw new ApiError(attachmentNotFoundMessage(id));
      api.storedAttachments.splice(index, 1);
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
      // 待ちの途中の取り下げ（abort）で流れを閉じる: 本物の fetch が abort で読みを打ち切るのに合わせるため
      const aborted = new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      for (const step of script) {
        if (signal.aborted) return;
        if (step instanceof Error) throw step;
        if (step instanceof Promise) {
          await Promise.race([step, aborted]);
          continue;
        }
        yield step;
      }
    },
    async uploadAttachment(file, signal) {
      api.uploadSignals.push(signal);
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
        if (api.conversationPageGate !== null) await api.conversationPageGate;
        if (api.conversationPageFails !== null) throw new Error(api.conversationPageFails);
      }
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
    interrupt(target) {
      api.interrupts += 1;
      api.interruptTargets.push(target);
      if (api.interruptFails !== null) return Promise.reject(new Error(api.interruptFails));
      return Promise.resolve(api.interruptOutcome);
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
      if (query.since !== undefined) {
        const since = query.since;
        rows = rows.filter((e) => e.at >= since);
      }
      if (query.until !== undefined) {
        const until = query.until;
        rows = rows.filter((e) => e.at <= until);
      }
      if (api.journalCursors) {
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

export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

export function journalEntry(
  id: string,
  type: JournalEntry['type'],
  at: string,
  extra: Record<string, unknown> = {},
): JournalEntry {
  return { id, at, type, ...extra } as unknown as JournalEntry;
}

export function minute(n: number): string {
  return new Date(Date.UTC(2026, 9, 2, 0, n)).toISOString();
}

export function said(n: number, text = `発言${String(n)}`): JournalEntry {
  return journalEntry(`e${String(n)}`, 'exchange', minute(n), {
    with: 'human',
    role: 'inbound',
    text,
  });
}

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

export function memoryDoc(slug: string, content: string): MemoryDoc {
  return {
    slug,
    content,
    createdAt: { kind: 'known', at: '2026-10-01T00:00:00.000Z' },
    updatedAt: '2026-10-02T00:00:00.000Z',
  };
}

/**
 * 試験用の偽の `TuiApi`。`chat()` は呼び出しごとに「台本」（イベント列）を 1 つ消費し、
 * 台本の途中に `Promise` を置くと、そこで止まって試験が好きな時に再開できる。
 */
import type {
  ChatEvent,
  ConversationMessage,
  ConversationSummary,
  HeaderCounts,
  ManagerListQuery,
  ManagerRow,
  TuiApi,
  UnreadableManager,
} from './api.js';

export type ScriptStep = ChatEvent | Promise<void> | Error;

export interface ChatCall {
  text: string;
  conversationId?: string;
}

export interface FakeApi extends TuiApi {
  chatCalls: ChatCall[];
  scripts: ScriptStep[][];
  ended: string[];
  interrupts: number;
  conversations: ConversationSummary[];
  messages: Record<string, ConversationMessage[]>;
  /** 窓が日誌の先頭に届いていない会話の id。 */
  unreachedStart: Set<string>;
  counts: HeaderCounts;
  journal: { events: (string | Error)[] }[];
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
    scripts: [],
    ended: [],
    interrupts: 0,
    conversations: [],
    messages: {},
    unreachedStart: new Set(),
    counts: { pendingApprovals: 0, runningManagers: 0 },
    journal: [],
    endFails: false,
    managerRows: [],
    unreadableManagers: [],
    managerListCalls: [],
    transcripts: {},
    managerMessages: [],
    stoppedManagers: [],
    managerListFails: null,
    stopResult: { outcome: 'stopped', detail: '止まったと確かめた。' },
    async *chat(input, signal) {
      api.chatCalls.push({
        text: input.text,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
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
    listConversations() {
      return Promise.resolve(api.conversations);
    },
    readConversation(id) {
      const messages = api.messages[id];
      return Promise.resolve(
        messages === undefined ? null : { messages, reachedStart: !api.unreachedStart.has(id) },
      );
    },
    endConversation(id) {
      api.ended.push(id);
      return api.endFails ? Promise.reject(new Error('終えられない')) : Promise.resolve();
    },
    interrupt() {
      api.interrupts += 1;
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
    async *journalStream(signal) {
      const stream = api.journal.shift();
      if (stream === undefined) {
        // 台本が無ければ繋がったまま黙る（中断されるまで待つ）。
        yield 'open';
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      for (const event of stream.events) {
        if (event instanceof Error) throw event;
        yield event;
      }
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

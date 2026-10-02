/**
 * 試験用の偽の `TuiApi`。`chat()` は呼び出しごとに「台本」（イベント列）を 1 つ消費し、
 * 台本の途中に `Promise` を置くと、そこで止まって試験が好きな時に再開できる。
 */
import type {
  ChatEvent,
  ConversationMessage,
  ConversationSummary,
  HeaderCounts,
  TuiApi,
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

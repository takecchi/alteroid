import { afterEach, expect } from 'vitest';
import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { renderMemoryDocuments } from './memory.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: unknown }).type === 'text')
    .map((b) => b.text)
    .join('');
}

export interface FakeCall {
  options: Options;
  inputs: string[];
  inputBlocks?: unknown[];
  kind: 'session' | 'sideQuery';
}

export function fakeSdk(
  reply: (input: string) => string = () => 'わかった',
  options: {
    delayMs?: number;
    failWith?: string;
    modelUsage?: (callIndex: number) => Record<string, unknown> | undefined;
    resultUsage?: (callIndex: number) => Record<string, unknown> | undefined;
    resultSubtype?: string;
    resultText?: string;
    resultFor?: (
      turnIndex: number,
    ) =>
      { subtype?: string; text?: string; isError?: boolean; apiErrorStatus?: number } | undefined;
    assistantErrorAt?: (turnIndex: number) => { error: string; text: string } | undefined;
    rateLimitEventAt?: (turnIndex: number) => Record<string, unknown> | undefined;
    systemNoticeAt?: (
      turnIndex: number,
    ) => { subtype: 'notification' | 'informational'; text: string } | undefined;
    beforeAssistant?: (callIndex: number) => SDKMessage[];
    permissionDenials?: (callIndex: number) => unknown[] | undefined;
    getContextUsage?: (callIndex: number) => unknown;
    endSessionAfterTurn?: number;
    mcpServers?: Array<{ name: string; status: string }>;
    /** init に足す欄（`plugins` / `plugin_errors` など）。呼び出し（セッション）ごとに変えられる */
    initExtras?: (callIndex: number) => Record<string, unknown>;
    /** init を出す前に待たせる（init が届かない窓を作る） */
    beforeInit?: (callIndex: number) => Promise<void> | undefined;
  } = {},
) {
  const calls: FakeCall[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const call: FakeCall = {
      options: params.options ?? {},
      inputs: [],
      inputBlocks: [],
      kind: typeof params.prompt === 'string' ? 'sideQuery' : 'session',
    };
    const callIndex = calls.length;
    calls.push(call);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      if (options.failWith !== undefined) throw new Error(options.failWith);

      await options.beforeInit?.(callIndex);
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
        model: 'claude-fake-init-model-xyz',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: options.mcpServers ?? [{ name: 'alteroid', status: 'connected' }],
        ...options.initExtras?.(callIndex),
      } as unknown as SDKMessage;

      const prompt = params.prompt;
      if (typeof prompt === 'string') {
        call.inputs.push(prompt);
        yield* turn(reply(prompt), 0);
        return;
      }

      let turnIndex = 0;
      for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
        const text = contentText(message.message.content);
        call.inputs.push(text);
        (call.inputBlocks ??= []).push(message.message.content);
        if (options.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        const idx = turnIndex;
        turnIndex += 1;
        yield* turn(reply(text), idx);
        if (options.endSessionAfterTurn === idx) return;
      }
    }

    function* turn(text: string, turnIndex: number): Generator<SDKMessage> {
      const rateLimitInfo = options.rateLimitEventAt?.(turnIndex);
      if (rateLimitInfo !== undefined) {
        yield {
          type: 'rate_limit_event',
          rate_limit_info: rateLimitInfo,
          session_id: 'sess-fake',
          uuid: `uuid-ratelimit-${turnIndex}`,
        } as unknown as SDKMessage;
      }
      const systemNotice = options.systemNoticeAt?.(turnIndex);
      if (systemNotice !== undefined) {
        yield {
          type: 'system',
          subtype: systemNotice.subtype,
          session_id: 'sess-fake',
          uuid: `uuid-sysnotice-${turnIndex}`,
          ...(systemNotice.subtype === 'notification'
            ? { text: systemNotice.text }
            : { content: systemNotice.text }),
        } as unknown as SDKMessage;
      }
      for (const message of options.beforeAssistant?.(callIndex) ?? []) yield message;
      // 無印の本文と両方を流さない: 実機では印付きの1本だけが来るため
      const assistantError = options.assistantErrorAt?.(turnIndex);
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: assistantError?.text ?? text }] },
        parent_tool_use_id: null,
        session_id: 'sess-fake',
        uuid: 'uuid-assistant',
        ...(assistantError === undefined ? {} : { error: assistantError.error }),
      } as unknown as SDKMessage;
      const modelUsage = options.modelUsage?.(callIndex);
      const resultUsage = options.resultUsage?.(callIndex);
      const resultOverride = options.resultFor?.(turnIndex);
      const denials = options.permissionDenials?.(callIndex);
      yield {
        type: 'result',
        subtype: resultOverride?.subtype ?? options.resultSubtype ?? 'success',
        result: resultOverride?.text ?? options.resultText ?? text,
        session_id: 'sess-fake',
        uuid: 'uuid-result',
        ...(resultOverride?.isError === undefined ? {} : { is_error: resultOverride.isError }),
        ...(resultOverride?.apiErrorStatus === undefined
          ? {}
          : { api_error_status: resultOverride.apiErrorStatus }),
        ...(modelUsage === undefined ? {} : { modelUsage }),
        ...(resultUsage === undefined ? {} : { usage: resultUsage }),
        ...(denials === undefined ? {} : { permission_denials: denials }),
      } as unknown as SDKMessage;
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
      ...(options.getContextUsage === undefined
        ? {}
        : { getContextUsage: async () => options.getContextUsage!(callIndex) }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, calls };
}

export interface Setup {
  clone: CloneHost;
  stores: Stores;
  calls: FakeCall[];
  events: ChatStreamEvent[];
  waitForEvents(predicate: (events: readonly ChatStreamEvent[]) => boolean): Promise<void>;
}

export function createEventSink(): {
  events: ChatStreamEvent[];
  push: (event: ChatStreamEvent) => void;
  waitForEvents: Setup['waitForEvents'];
} {
  const events: ChatStreamEvent[] = [];
  const waiters: {
    predicate: (events: readonly ChatStreamEvent[]) => boolean;
    resolve: () => void;
  }[] = [];
  function notifyWaiters(): void {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const candidate = waiters[i];
      if (candidate !== undefined && candidate.predicate(events)) {
        waiters.splice(i, 1);
        candidate.resolve();
      }
    }
  }
  function waitForEvents(
    predicate: (events: readonly ChatStreamEvent[]) => boolean,
  ): Promise<void> {
    if (predicate(events)) return Promise.resolve();
    return new Promise((resolve) => {
      waiters.push({ predicate, resolve });
    });
  }
  eventWaiters.set(events, waitForEvents);
  return {
    events,
    push: (event) => {
      events.push(event);
      notifyWaiters();
    },
    waitForEvents,
  };
}

export function wireEvents(
  clone: CloneHost,
  conversationId: string,
): { events: ChatStreamEvent[]; waitForEvents: Setup['waitForEvents'] } {
  const { events, push, waitForEvents } = createEventSink();
  clone.subscribe(conversationId, push);
  return { events, waitForEvents };
}

// 引けなかったら壁時計へ落とさない: 落とすと壁時計の待ちが引けなかったときだけ静かに戻るため
const eventWaiters = new WeakMap<ChatStreamEvent[], Setup['waitForEvents']>();

export function waitForEventsOf(events: ChatStreamEvent[], label: string): Setup['waitForEvents'] {
  const waitForEvents = eventWaiters.get(events);
  if (waitForEvents === undefined) {
    throw new Error(
      `${label}: この events 配列は wireEvents が配線したものではないので、出来事を` +
        '直接つかむ待ち方ができない。壁時計のポーリングへは落とさない（#1220）。' +
        'events は wireEvents / setup / setupScripted が返したものを渡すこと。',
    );
  }
  return waitForEvents;
}

export function setup(
  reply?: (input: string) => string,
  stores: Stores = createMemoryStores(),
  sdkOptions: Parameters<typeof fakeSdk>[1] = {},
  // 既定は空にする: 手元の ALTEROID_CLONE_MODEL の有無でテストの結果を変えないため
  env: NodeJS.ProcessEnv = {},
): Setup {
  const { fn, calls } = fakeSdk(reply, sdkOptions);
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fn,
    env,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const { events, waitForEvents } = wireEvents(clone, 'conv-1');
  return { clone, stores, calls, events, waitForEvents };
}

export function lineStartingWith(text: string, prefix: string): string {
  const matches = text.split('\n').filter((line) => line.startsWith(prefix));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

// calls の末尾を使わず種類で指す: 蒸留のサイドクエリは畳みの後に遅れて積まれ、末尾が本流である保証が無いため
export function lastSessionCall(calls: FakeCall[]): FakeCall {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i]!;
    if (call.kind === 'session') return call;
  }
  throw new Error('本流のセッションの呼び出しが1本も無い');
}

// 待ちの打ち切りを壁時計で持たない: 3000 を大きくしても賭けが残り、tick 数での締め切りは本物のタイマー（fakeSdk の delayMs）を跨ぐと空回りで尽きるため
type PendingWait = { readonly label: string };

const pendingWaits = new Set<PendingWait>();

// 待ちはテストの寿命で切る: 解けない待ちが setTimeout を積み続け、次のテストの器を食うため
let testEpoch = 0;

afterEach(() => {
  testEpoch += 1;
  if (pendingWaits.size === 0) return;
  const labels = [...pendingWaits].map((wait) => wait.label);
  pendingWaits.clear();
  // stdout に書かない: vitest.setup.ts の歯がテストを落とすため
  process.stderr.write(
    `⚠️ このテストが終わった時点で、解けていない待ちが ${labels.length} 本ある。` +
      'テストが testTimeout で落ちたなら、落ちた理由はこれである可能性が高い' +
      '（#1220 で壁時計の打ち切りを外したので、待ち自身はもう例外を投げない）:\n' +
      labels.map((label) => `  - ${label}\n`).join(''),
  );
});

export async function waitFor(
  check: () => Promise<boolean> | boolean,
  label: string,
): Promise<void> {
  if (await check()) return;
  const epoch = testEpoch;
  const wait: PendingWait = { label };
  pendingWaits.add(wait);
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      // 「起きない」と言い切らない: 言えるのは「テストが終わるまでに起きなかった」までで、「まだ起きていない」と区別できないため
      if (testEpoch !== epoch) {
        throw new Error(`${label} を待っている途中でテストが終わった（待ちは解けていない）`);
      }
      if (await check()) return;
    }
  } finally {
    pendingWaits.delete(wait);
  }
}

export async function waitForExpect(
  assertion: () => void | Promise<void>,
  label: string,
): Promise<void> {
  await waitFor(async () => {
    try {
      await assertion();
      return true;
    } catch {
      return false;
    }
  }, label);
  // 解けた後にもう一度 assertion を実行する: 失敗時に通常の diff を出し、vitest に1個の expect として数えさせるため
  await assertion();
}

export function waitForDone(events: ChatStreamEvent[]): Promise<void> {
  return waitForEventsOf(
    events,
    'done の待ち',
  )((seen) => seen.some((event) => event.type === 'done'));
}

export const isTerminal = (event: ChatStreamEvent): boolean =>
  event.type === 'done' || event.type === 'error';

// 終端の種類を見ない: error だけを待つと、分岐を消した変異で error が永久に来ずタイムアウトで落ち、歯があった証拠にならないため
export async function waitForTerminal(events: ChatStreamEvent[]): Promise<void> {
  await waitForEventsOf(events, '終端の待ち')((seen) => seen.some(isTerminal));
}

// 壁時計ではなく microtask を進める: error イベントの後に続く journal 書き込みや #query = null の前に waitForTerminal が解決する窓があり、待っているのは常に microtask の連鎖のため
export async function flushPendingMicrotasks(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

// 期待値を手で書き写さない: 節id はハッシュなので写せば腐る。焼き込みと同じ renderMemoryDocuments に通して取る
export async function memoryCardOutlineLines(stores: Stores, slug: string): Promise<string[]> {
  const doc = (await stores.persona.documents()).find((entry) => entry.slug === slug);
  if (doc === undefined) throw new Error(`記憶に ${slug} が無い`);
  const outline = renderMemoryDocuments([doc])
    .split('\n')
    .filter((line) => /^\s*\[[0-9a-f]{8}-[0-9a-f]{8}\] /.test(line));
  // 0 行のまま返さない: 以降の toContain / not.toContain が1つも走らないまま緑になるため
  if (outline.length === 0) throw new Error(`${slug} のカードに節の目次が無い`);
  return outline;
}

export function fakeGatedSdk() {
  const calls: FakeCall[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const call: FakeCall = {
      options: params.options ?? {},
      inputs: [],
      inputBlocks: [],
      kind: typeof params.prompt === 'string' ? 'sideQuery' : 'session',
    };
    calls.push(call);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        // 本文を控えてから止める: 止めてから控えると「ターンが始まった」を観測できないため
        call.inputs.push(contentText(message.message.content));
        (call.inputBlocks ??= []).push(message.message.content);
        await gate;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return {
    fn,
    calls,
    release: () => release(),
  };
}

export type ScriptedStep =
  | { delta: string }
  | {
      assistant: Array<{ type: 'text'; text: string } | { type: 'tool_use'; name: string }>;
      error?: string;
    }
  | { toolResult: true }
  | { run: () => Promise<unknown> }
  | { start: () => Promise<unknown> };

export function fakeScriptedSdk(
  script: (turnIndex: number, input: string) => ScriptedStep[],
  options: { resultSubtype?: string } = {},
) {
  const settled: Promise<unknown>[] = [];
  const fn = ((params: { prompt: unknown }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-scripted',
        uuid: 'uuid-init',
        model: 'claude-fake-init-model-xyz',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;
      if (typeof params.prompt === 'string') {
        yield {
          type: 'result',
          subtype: 'success',
          result: '',
          session_id: 'sess-scripted',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
        return;
      }
      let turnIndex = 0;
      let seq = 0;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        const idx = turnIndex;
        turnIndex += 1;
        for (const step of script(idx, contentText(message.message.content))) {
          seq += 1;
          if ('delta' in step) {
            yield {
              type: 'stream_event',
              event: {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: step.delta },
              },
              parent_tool_use_id: null,
              session_id: 'sess-scripted',
              uuid: `uuid-delta-${seq}`,
            } as unknown as SDKMessage;
          } else if ('assistant' in step) {
            yield {
              type: 'assistant',
              message: { content: step.assistant },
              ...(step.error === undefined ? {} : { error: step.error }),
              parent_tool_use_id: null,
              session_id: 'sess-scripted',
              uuid: `uuid-assistant-${seq}`,
            } as unknown as SDKMessage;
          } else if ('toolResult' in step) {
            yield {
              type: 'user',
              message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
              parent_tool_use_id: null,
              session_id: 'sess-scripted',
              uuid: `uuid-user-${seq}`,
            } as unknown as SDKMessage;
          } else if ('run' in step) {
            await step.run();
          } else {
            settled.push(step.start());
          }
        }
        yield {
          type: 'result',
          subtype: options.resultSubtype ?? 'success',
          result: '',
          session_id: 'sess-scripted',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, settled };
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { conversationMessages, readConversationWindow } from './conversation.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, fakeScriptedSdk, waitForTerminal, wireEvents } from './clone-test-harness.js';
import type { ScriptedStep } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { JournalEntry } from './schema.js';

const T0 = Date.parse('2026-10-07T00:00:00.000Z');
const at = (ms: number): void => {
  vi.setSystemTime(T0 + ms);
};

function setupScripted(
  script: (tools: {
    ask: () => Promise<unknown>;
    setClock: (ms: number) => void;
  }) => ScriptedStep[],
  options: { resultSubtype?: string } = {},
) {
  const stores = createMemoryStores();
  let captured: ToolContext | undefined;
  const ask = async (): Promise<unknown> => {
    const tool = createCloneTools(captured!).find((t) => t.name === 'ask_human');
    return tool?.handler({ question: '進めてよいか' } as never, {});
  };
  const { fn, settled } = fakeScriptedSdk(() => script({ ask, setClock: at }), options);
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fn,
    env: {},
    mcpServerFactory: (context) => {
      captured = context;
      return createCloneMcpServer(context);
    },
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const { events } = wireEvents(clone, 'conv-1');
  return { clone, stores, events, settled };
}

async function outbound(stores: ReturnType<typeof createMemoryStores>) {
  const rows = await stores.journal.list({ types: ['exchange'], with: ['human'], order: 'asc' });
  return rows.filter(
    (row): row is Extract<JournalEntry, { type: 'exchange' }> =>
      row.type === 'exchange' && row.role === 'outbound',
  );
}

function interleave(
  messages: Array<{ at: string; label: string }>,
  cards: Array<{ at: string; label: string }>,
): string[] {
  return [...messages.map((m) => ({ ...m, rank: 0 })), ...cards.map((c) => ({ ...c, rank: 1 }))]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.rank - b.rank))
    .map((x) => x.label);
}

const SPLIT_TURN = ({
  ask,
  setClock,
}: {
  ask: () => Promise<unknown>;
  setClock: (ms: number) => void;
}): ScriptedStep[] => [
  { delta: '前半です' },
  {
    assistant: [
      { type: 'text', text: '前半です' },
      { type: 'tool_use', name: 'ask_human' },
    ],
  },
  {
    run: async () => {
      setClock(10);
      await ask();
      setClock(20);
    },
  },
  { toolResult: true },
  { delta: '後半です' },
  { assistant: [{ type: 'text', text: '後半です' }] },
];

describe('返答の本文を承認カードの区切りごとに日誌へ書く（#3605）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(1) 日誌の outbound exchange が「前半」「後半」の2件になり、会話 id を同じく持つ', async () => {
    const s = setupScripted(SPLIT_TURN);
    s.clone.post(humanMessage('進めてよいか確認して'));
    await waitForTerminal(s.events);
    await Promise.all(s.settled);

    const rows = await outbound(s.stores);
    expect(rows.map((r) => r.text)).toEqual(['前半です', '後半です']);
    expect(rows.map((r) => r.conversationId)).toEqual(['conv-1', 'conv-1']);
    await s.clone.stop();
  });

  it('(2) 承認の createdAt は前半の at 以降、後半の at より前', async () => {
    const s = setupScripted(SPLIT_TURN);
    s.clone.post(humanMessage('進めてよいか確認して'));
    await waitForTerminal(s.events);

    const [first, second] = await outbound(s.stores);
    const [approval] = (await s.stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(approval).toBeDefined();
    expect(first!.at <= approval!.createdAt).toBe(true);
    expect(second!.at > approval!.createdAt).toBe(true);
    await s.clone.stop();
  });

  it('(3) 会話の履歴と承認を時刻で並べると [発言, 前半, カード, 後半] になる', async () => {
    const s = setupScripted(SPLIT_TURN);
    s.clone.post(humanMessage('進めてよいか確認して'));
    await waitForTerminal(s.events);

    const window = await readConversationWindow(s.stores.journal, { scan: 100 });
    const messages = conversationMessages(window, 'conv-1');
    const [approval] = (await s.stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(
      interleave(
        messages.map((m) => ({ at: m.at, label: m.text })),
        [{ at: approval!.createdAt, label: 'カード' }],
      ),
    ).toEqual(['進めてよいか確認して', '前半です', 'カード', '後半です']);
    await s.clone.stop();
  });

  it('(4) ふつうの道具だけを挟んだターンは1件のまま', async () => {
    const s = setupScripted(() => [
      { delta: '前半です' },
      {
        assistant: [
          { type: 'text', text: '前半です' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
      { toolResult: true },
      { delta: '後半です' },
      { assistant: [{ type: 'text', text: '後半です' }] },
    ]);
    s.clone.post(humanMessage('読んで'));
    await waitForTerminal(s.events);

    expect((await outbound(s.stores)).map((r) => r.text)).toEqual(['前半です\n\n後半です']);
    await s.clone.stop();
  });

  it('(5) 古い形（1ターン1件）の行の読み出しは変わらない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '昔の発言',
      conversationId: 'conv-old',
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '前半です後半です',
      conversationId: 'conv-old',
    });
    const window = await readConversationWindow(stores.journal, { scan: 100 });
    expect(conversationMessages(window, 'conv-old').map((m) => [m.role, m.text])).toEqual([
      ['inbound', '昔の発言'],
      ['outbound', '前半です後半です'],
    ]);
  });

  it('(6) 失敗ターンでも前半は日誌に残り、失敗の前置きは最後の行に付く', async () => {
    const s = setupScripted(SPLIT_TURN, { resultSubtype: 'error_during_execution' });
    s.clone.post(humanMessage('進めてよいか確認して'));
    await waitForTerminal(s.events);

    const rows = await outbound(s.stores);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text).toBe('前半です');
    expect(rows[1]!.text).toBe(
      '（このターンは失敗して終わった。以下は失敗する前に出ていた本文である）\n後半です',
    );
    await s.clone.stop();
  });

  it('(7) 道具がクローンの本文の処理より先に走り出しても、受信中に見えた順で区切る', async () => {
    const s = setupScripted(({ ask, setClock }) => [
      { delta: '前半です' },
      { start: () => (setClock(10), ask()) },
      {
        assistant: [
          { type: 'text', text: '前半です' },
          { type: 'tool_use', name: 'ask_human' },
        ],
      },
      { run: async () => setClock(20) },
      { toolResult: true },
      { delta: '後半です' },
      { assistant: [{ type: 'text', text: '後半です' }] },
    ]);
    s.clone.post(humanMessage('進めてよいか確認して'));
    await waitForTerminal(s.events);
    await Promise.all(s.settled);

    expect(
      s.events.flatMap((e) =>
        e.type === 'text' ? [e.text] : e.type === 'ask_human' ? ['カード'] : [],
      ),
    ).toEqual(['前半です', 'カード', '後半です']);
    expect((await outbound(s.stores)).map((r) => r.text)).toEqual(['前半です', '後半です']);
    await s.clone.stop();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, fakeScriptedSdk, waitForTerminal, wireEvents } from './clone-test-harness.js';
import type { ScriptedStep } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { JournalEntry } from './schema.js';

// 1つのターンの中で本文が前のメッセージの後に再開したとき、日誌の本文の境目に区切り（空行）が入る（#4339）。
// 画面へ流れる SSE の `text` には入らない。

function setup(script: (ask: () => Promise<unknown>) => ScriptedStep[]) {
  const stores = createMemoryStores();
  let captured: ToolContext | undefined;
  const ask = async (): Promise<unknown> => {
    const tool = createCloneTools(captured!).find((t) => t.name === 'ask_human');
    return tool?.handler({ question: '進めてよいか' } as never, {});
  };
  const { fn } = fakeScriptedSdk(() => script(ask));
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
  return { clone, stores, events };
}

async function outboundTexts(stores: ReturnType<typeof createMemoryStores>): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'], with: ['human'], order: 'asc' });
  return rows
    .filter(
      (row): row is Extract<JournalEntry, { type: 'exchange' }> =>
        row.type === 'exchange' && row.role === 'outbound',
    )
    .map((row) => row.text);
}

describe('返答の本文の境目に区切りを入れる（#4339）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('本文 → 道具 → 本文 のターンは、日誌の本文の境目に空行が入る', async () => {
    const s = setup(() => [
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

    expect(await outboundTexts(s.stores)).toEqual(['前半です\n\n後半です']);
    // 画面へ流れる text には区切りを入れない
    const sent = s.events.flatMap((e) =>
      (e as { type?: string }).type === 'text' ? [(e as { text: string }).text] : [],
    );
    expect(sent.join('')).toBe('前半です後半です');
    await s.clone.stop();
  });

  it('逐次配信の無い（text ブロックだけの）ターンでも同じ', async () => {
    const s = setup(() => [
      {
        assistant: [
          { type: 'text', text: '前半です' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
      { toolResult: true },
      { assistant: [{ type: 'text', text: '後半です' }] },
    ]);
    s.clone.post(humanMessage('読んで'));
    await waitForTerminal(s.events);

    expect(await outboundTexts(s.stores)).toEqual(['前半です\n\n後半です']);
    await s.clone.stop();
  });

  it('道具を挟まない（1メッセージの）ターンは変わらない', async () => {
    const s = setup(() => [
      { delta: '前半' },
      { delta: '後半' },
      { assistant: [{ type: 'text', text: '前半後半' }] },
    ]);
    s.clone.post(humanMessage('こんにちは'));
    await waitForTerminal(s.events);

    expect(await outboundTexts(s.stores)).toEqual(['前半後半']);
    await s.clone.stop();
  });

  it('先頭が道具だけのメッセージなら、先頭に区切りを置かない', async () => {
    const s = setup(() => [
      { assistant: [{ type: 'tool_use', name: 'Read' }] },
      { toolResult: true },
      { delta: '答えです' },
      { assistant: [{ type: 'text', text: '答えです' }] },
    ]);
    s.clone.post(humanMessage('読んで'));
    await waitForTerminal(s.events);

    expect(await outboundTexts(s.stores)).toEqual(['答えです']);
    await s.clone.stop();
  });

  it('弾かれたメッセージの分を外す切り詰めは、区切りごと外れて前の本文を壊さない', async () => {
    const s = setup(() => [
      { delta: '前半です' },
      {
        assistant: [
          { type: 'text', text: '前半です' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
      { toolResult: true },
      { delta: '上限に達しました' },
      { assistant: [{ type: 'text', text: '上限に達しました' }], error: 'rate_limit' },
    ]);
    s.clone.post(humanMessage('読んで'));
    await waitForTerminal(s.events);

    const texts = await outboundTexts(s.stores);
    expect(texts.join('')).toContain('前半です');
    expect(texts.join('')).not.toContain('上限に達しました');
    expect(texts.join('').endsWith('\n\n')).toBe(false);
    await s.clone.stop();
  });

  it('弾かれたメッセージの後に本文が続くと、その前に区切りが入る', async () => {
    const s = setup(() => [
      { delta: '前半です' },
      { assistant: [{ type: 'text', text: '前半です' }] },
      { delta: '弾かれた' },
      { assistant: [{ type: 'text', text: '弾かれた' }], error: 'rate_limit' },
      { delta: '後半です' },
      { assistant: [{ type: 'text', text: '後半です' }] },
    ]);
    s.clone.post(humanMessage('読んで'));
    await waitForTerminal(s.events);

    const texts = await outboundTexts(s.stores);
    expect(texts.join('')).toContain('前半です\n\n後半です');
    expect(texts.join('')).not.toContain('弾かれた');
    await s.clone.stop();
  });

  it('承認カードで割った直後の行は、先頭に区切りを持たない', async () => {
    const s = setup((ask) => [
      { delta: '前半です' },
      {
        assistant: [
          { type: 'text', text: '前半です' },
          { type: 'tool_use', name: 'ask_human' },
        ],
      },
      { run: async () => void (await ask()) },
      { toolResult: true },
      { delta: '後半です' },
      { assistant: [{ type: 'text', text: '後半です' }] },
    ]);
    s.clone.post(humanMessage('確認して'));
    await waitForTerminal(s.events);

    expect(await outboundTexts(s.stores)).toEqual(['前半です', '後半です']);
    await s.clone.stop();
  });
});

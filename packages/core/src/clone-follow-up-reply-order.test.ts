import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, fakeScriptedSdk, waitForTerminal, wireEvents } from './clone-test-harness.js';
import type { ScriptedStep } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { JournalEntry } from './schema.js';

type Exchange = Extract<JournalEntry, { type: 'exchange' }>;

async function conversation(stores: ReturnType<typeof createMemoryStores>): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'], with: ['human'], order: 'asc' });
  return rows
    .filter((row): row is Exchange => row.type === 'exchange')
    .map((row) => `${row.role === 'inbound' ? '人間' : 'クローン'}: ${row.text}`);
}

function setup(script: (turnIndex: number, clone: () => CloneHost) => ScriptedStep[]) {
  const stores = createMemoryStores();
  const { fn } = fakeScriptedSdk((turnIndex) => script(turnIndex, () => clone));
  const clone: CloneHost = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const { events } = wireEvents(clone, 'conv-1');
  return { clone, stores, events };
}

describe('ターン中に届いた人間の発言は、そこまでに流れた返答の後ろに記録される（#4391）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('本文 → （人間の発言）→ 道具 → 本文 のターンは、発言の前後で返答が割れて日誌に載る', async () => {
    const s = setup((turnIndex, clone) =>
      turnIndex === 0
        ? [
            { delta: 'AIの回答2' },
            {
              assistant: [
                { type: 'text', text: 'AIの回答2' },
                { type: 'tool_use', name: 'Read' },
              ],
            },
            {
              run: async () => {
                clone().post(humanMessage('回答2への返事'));
                await vi.waitFor(async () => {
                  expect(await conversation(s.stores)).toContain('人間: 回答2への返事');
                });
              },
            },
            { toolResult: true },
            { delta: '続き' },
            { assistant: [{ type: 'text', text: '続き' }] },
          ]
        : [{ delta: '返事への答え' }, { assistant: [{ type: 'text', text: '返事への答え' }] }],
    );
    s.clone.post(humanMessage('質問2'));
    await waitForTerminal(s.events);
    await vi.waitFor(async () => {
      expect(await conversation(s.stores)).toContain('クローン: 返事への答え');
    });

    expect(await conversation(s.stores)).toEqual([
      '人間: 質問2',
      'クローン: AIの回答2',
      '人間: 回答2への返事',
      'クローン: 続き',
      'クローン: 返事への答え',
    ]);

    // 画面が返信の行を分ける `queued` は、割り目より前の本文の後・後の本文の前に流れる
    const stream = s.events.flatMap((e) => {
      const event = e as { type?: string; text?: string };
      if (event.type === 'text') return [`text:${event.text}`];
      if (event.type === 'queued') return ['queued'];
      return [];
    });
    const split = stream.lastIndexOf('queued');
    expect(stream.slice(0, split)).toContain('text:AIの回答2');
    expect(stream.slice(split)).toContain('text:続き');
    await s.clone.stop();
  });

  it('別の会話の発言では割らない', async () => {
    const s = setup((turnIndex, clone) =>
      turnIndex === 0
        ? [
            { delta: '前半' },
            {
              run: async () => {
                clone().post(humanMessage('別の話', 'conv-2'));
                await vi.waitFor(async () => {
                  expect(await conversation(s.stores)).toContain('人間: 別の話');
                });
              },
            },
            { delta: '後半' },
            { assistant: [{ type: 'text', text: '前半後半' }] },
          ]
        : [{ delta: '別の答え' }, { assistant: [{ type: 'text', text: '別の答え' }] }],
    );
    s.clone.post(humanMessage('質問'));
    await waitForTerminal(s.events);

    expect(await conversation(s.stores)).toContain('クローン: 前半後半');
    await s.clone.stop();
  });
});

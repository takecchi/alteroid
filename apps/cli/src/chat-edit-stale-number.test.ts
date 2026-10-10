import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout, pretendStdinTty } from './test-support.js';

/**
 * 編集が受け付けられたら、/conversation の番号は置き換えた前の発言を指さない。
 */
let lines: string[] = [];

vi.mock('node:readline/promises', () => ({
  createInterface: () => {
    const mine = lines;
    const handlers: { line?: (text: string) => void; close?: () => void } = {};
    return {
      on: (event: string, handler: (text: string) => void) => {
        if (event === 'line') handlers.line = handler;
      },
      once: (_event: 'close', handler: () => void) => {
        handlers.close = handler;
      },
      setPrompt: () => undefined,
      prompt: () => {
        queueMicrotask(() => {
          const next = mine.shift();
          if (next === undefined) handlers.close?.();
          else handlers.line?.(next);
        });
      },
      close: () => undefined,
    };
  },
}));

vi.mock('./target.js', async (orig) => ({
  ...(await orig<typeof import('./target.js')>()),
  resolveTarget: async () => ({
    baseUrl: 'http://127.0.0.1:4517',
    headers: {},
    remote: false,
    note: null,
  }),
}));

let chatCommand: typeof import('./chat.js').chatCommand;
beforeAll(async () => {
  ({ chatCommand } = await import('./chat.js'));
}, 60_000);

let restoreStdinTty: () => void;
beforeEach(() => {
  restoreStdinTty = pretendStdinTty(true);
});

afterEach(() => {
  restoreStdinTty();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CONVERSATION = {
  conversationId: 'conv-1',
  messages: [
    { id: 'm1', at: '2026-08-16T10:00:00.000Z', role: 'inbound', text: '最初の本文' },
    { id: 'm2', at: '2026-08-16T10:01:00.000Z', role: 'inbound', text: '二つ目の本文' },
  ],
  scanned: 2,
  reachedStart: true,
  supersededCount: 0,
};

async function run(
  input: string[],
  chatReply: () => Response | undefined = () => undefined,
): Promise<{ chatBodies: Record<string, unknown>[]; output: string }> {
  lines = [...input];
  const chatBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/chat')) {
      chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const replaced = chatReply();
      if (replaced !== undefined) return Promise.resolve(replaced);
      return Promise.resolve(
        new Response('event: done\ndata: {"type":"done"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    }
    if (/\/conversations\/conv-1(\?|$)/.test(u))
      return Promise.resolve(Response.json(CONVERSATION));
    return Promise.resolve(Response.json({}));
  });
  const out = captureStdout();
  await chatCommand();
  return { chatBodies, output: out() };
}

const OPEN = '/conversation conv-1';
const REREAD = '/conversation で読み直してください';

describe('chat: 編集が受け付けられたあとの /conversation の番号（#4088）', () => {
  it('1行の /edit が受け付けられたら、同じ番号でもう一度編集を送らず、読み直しを案内する', async () => {
    const { chatBodies, output } = await run([OPEN, '/edit 1 新しい本文', '/edit 1 もう一度']);
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({ supersedes: 'm1', text: '新しい本文' });
    expect(output).toContain(REREAD);
  });

  it('編集の確定が受け付けられたら、同じ番号で編集を始められず、元の本文も出さない', async () => {
    const { chatBodies, output } = await run([OPEN, '/edit 1', '新しい本文', '/edit 1']);
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({ supersedes: 'm1', text: '新しい本文' });
    expect(output).toContain(REREAD);
    expect(output.match(/編集を始めます/g)).toHaveLength(1);
  });

  it('置き換えていない別の番号は、読み直さなくても同じ発言を指す', async () => {
    const { chatBodies } = await run([OPEN, '/edit 1 一つ目', '/edit 2 二つ目']);
    expect(chatBodies.map((body) => body.supersedes)).toEqual(['m1', 'm2']);
  });

  it('読み直せば、新しい並びの番号でまた編集できる', async () => {
    const { chatBodies } = await run([OPEN, '/edit 1 新しい本文', OPEN, '/edit 2 別の本文']);
    expect(chatBodies.map((body) => body.supersedes)).toEqual(['m1', 'm2']);
  });

  it('断られた編集では番号を残す（置き換わっていないので、直して送り直せる）', async () => {
    const { chatBodies } = await run([OPEN, '/edit 1 一回目', '/edit 1 二回目'], () =>
      Response.json({ error: 'bad' }, { status: 400 }),
    );
    expect(chatBodies.map((body) => body.text)).toEqual(['一回目', '二回目']);
  });
});

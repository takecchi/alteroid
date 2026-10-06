import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout, pretendStdinTty } from './test-support.js';

/**
 * readline に流す行（尽きたら閉じる）。**`run` ごとに作り直し、偽の readline は作られた時点の配列を握る。**
 * 共有の1本だと、時間切れで置き去りになった前のテストの `chatCommand` が、次のテストの行を横取りして送る。
 */
let lines: string[] = [];

vi.mock('node:readline/promises', () => ({
  // `chat.ts` は `line` / `close` イベントで読む（#3262）。`prompt()` のたびに次の行を流し、尽きたら閉じる。
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

// chat.ts（ink・react・api-client まで引く）の初回の読み込みは、負荷の高い器で数秒かかる。最初のテストの
// 5秒に含めない（含めると時間切れのあと、置き去りの実行が次のテストへ食い込む）。
let chatCommand: typeof import('./chat.js').chatCommand;
beforeAll(async () => {
  ({ chatCommand } = await import('./chat.js'));
}, 60_000);

// 対話の入力（端末）の形。非対話では、送信の失敗で止まる（#3413）。
let restoreStdinTty: () => void;
beforeEach(() => {
  restoreStdinTty = pretendStdinTty(true);
});

afterEach(() => {
  restoreStdinTty();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sse = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const frame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
/** `open` を一度も見せずに閉じる SSE（2xx のあとで切れた）。 */
const cutBeforeOpen = () => sse('');
const normal = (conversationId: string) =>
  sse(frame('open', { conversationId }) + frame('done', { type: 'done' }));

async function run(
  input: string[],
  chatReply: (n: number) => Response,
  lookup: (n: number, id: string) => Response,
): Promise<{ chatBodies: Record<string, unknown>[]; lookups: string[]; output: string }> {
  lines = [...input];
  const chatBodies: Record<string, unknown>[] = [];
  const lookups: string[] = [];
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/chat') && init?.method === 'POST') {
      chatBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(chatReply(chatBodies.length - 1));
    }
    const m = /\/client-messages\/([^/?]+)$/.exec(u);
    if (m !== null) {
      lookups.push(decodeURIComponent(m[1] ?? ''));
      return Promise.resolve(lookup(lookups.length - 1, m[1] ?? ''));
    }
    return Promise.resolve(Response.json({}));
  });
  const out = captureStdout();
  await chatCommand();
  return { chatBodies, lookups, output: out() };
}

describe('chat: 新しい会話で open の前に SSE が切れた送信の取り直し（#3304）', () => {
  it('受け取り済みなら、次の発言は取り直した会話へ送る（会話が黙って分かれない）', async () => {
    const { chatBodies, lookups } = await run(
      ['最初', '次'],
      (n) => (n === 0 ? cutBeforeOpen() : normal('cA')),
      () => Response.json({ conversationId: 'cA' }),
    );
    expect(chatBodies).toHaveLength(2);
    expect(lookups).toEqual([chatBodies[0]?.clientMessageId]);
    expect(chatBodies[1]).toMatchObject({ text: '次', conversationId: 'cA' });
    expect(chatBodies[1]?.clientMessageId).not.toBe(chatBodies[0]?.clientMessageId);
  });

  it('404 なら新しい会話として送り、覚えていた id は捨てる', async () => {
    const { chatBodies, lookups } = await run(
      ['最初', '次', '次の次'],
      (n) => (n === 0 ? cutBeforeOpen() : normal('cB')),
      () => Response.json({ error: '受け取っていない clientMessageId' }, { status: 404 }),
    );
    expect(lookups).toHaveLength(1);
    expect(chatBodies[1]?.conversationId).toBeUndefined();
    expect(chatBodies[2]).toMatchObject({ conversationId: 'cB' });
  });

  it('引けなかったら新しい会話として送らない。もう一度送るよう案内し、次の送信で引き直す', async () => {
    const { chatBodies, lookups, output } = await run(
      ['最初', '次', '次'],
      (n) => (n === 0 ? cutBeforeOpen() : normal('cA')),
      (n) =>
        n === 0
          ? Response.json({ error: '一時的な失敗' }, { status: 503 })
          : Response.json({ conversationId: 'cA' }),
    );
    expect(chatBodies.map((b) => b.text)).toEqual(['最初', '次']);
    expect(lookups).toHaveLength(2);
    expect(chatBodies[1]).toMatchObject({ conversationId: 'cA' });
    expect(output).toContain('一時的な失敗');
    expect(output).toContain('もう一度送って');
  });

  it('取り直した会話でもう一度 open の前に切れたら、その会話 id を使い続ける', async () => {
    const { chatBodies, lookups } = await run(
      ['最初', '次', '次の次'],
      (n) => (n === 2 ? normal('cA') : cutBeforeOpen()),
      () => Response.json({ conversationId: 'cA' }),
    );
    expect(lookups).toHaveLength(1);
    expect(chatBodies[1]).toMatchObject({ conversationId: 'cA' });
    expect(chatBodies[2]).toMatchObject({ conversationId: 'cA' });
  });
});

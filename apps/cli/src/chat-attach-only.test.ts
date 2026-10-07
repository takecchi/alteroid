import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { captureStdout, pretendStdinTty } from './test-support.js';

// `run` ごとに作り直す: 共有の1本だと、時間切れで置き去りになった前のテストの `chatCommand` が、次のテストの行を横取りして送るため
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

// 最初のテストの5秒に chat.ts の初回の読み込みを含めない: 負荷の高い器で数秒かかり、時間切れのあと置き去りの実行が次のテストへ食い込むため
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

async function run(
  input: string[],
  chatReply: (n: number) => Response | undefined = () => undefined,
): Promise<{ chatBodies: Record<string, unknown>[]; uploads: number; output: string }> {
  lines = [...input];
  const chatBodies: Record<string, unknown>[] = [];
  let uploads = 0;
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/chat')) {
      chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const replaced = chatReply(chatBodies.length - 1);
      if (replaced !== undefined) return Promise.resolve(replaced);
      return Promise.resolve(
        new Response('event: done\ndata: {"type":"done"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    }
    if (u.includes('/attachments')) {
      if (init?.method === 'POST') uploads += 1;
      return Promise.resolve(
        Response.json({
          id: `att-${uploads}`,
          name: 'a.log',
          mediaType: 'text/plain',
          size: 1,
          sha256: 'x',
        }),
      );
    }
    return Promise.resolve(Response.json({}));
  });
  const out = captureStdout();
  await chatCommand();
  const output = out();
  return { chatBodies, uploads, output };
}

describe('chat: 添えかけがあるときの空行（添付だけの発言）', () => {
  it('/attach のあとの空行で text:"" と attachments が /chat に送られ、その後の空行は送らない', async () => {
    const dir = await makeTempDir('alteroid-chat-only-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'x');
    const { chatBodies } = await run([`/attach ${path}`, '', '']);
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({ text: '', attachments: ['att-1'] });
  });

  it('attachment_missing で落ちたら、上げ済みの印を捨てて、次の送信で上げ直す（#3246）', async () => {
    const dir = await makeTempDir('alteroid-chat-only-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'x');
    const { chatBodies, uploads, output } = await run([`/attach ${path}`, '見て', '見て'], (n) =>
      n === 0
        ? Response.json(
            { error: '添付が見つからない（期限切れの可能性）: att-1', code: 'attachment_missing' },
            { status: 400 },
          )
        : undefined,
    );
    expect(uploads).toBe(2);
    expect(chatBodies.map((b) => b.attachments)).toEqual([['att-1'], ['att-2']]);
    expect(output).toContain('次の送信で上げ直す');
  });

  it('添えかけが無い空行は送らない', async () => {
    const { chatBodies } = await run(['', '']);
    expect(chatBodies).toEqual([]);
  });
});

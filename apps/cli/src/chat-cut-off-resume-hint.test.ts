import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout, pretendStdinTty } from './test-support.js';

/**
 * #4089: 応答の途中で接続が切れたら、ターンがデーモンで続いていること・/resume で戻れること・
 * 完成した返信は /conversation で読めることを言う。
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

const OPEN = 'event: open\ndata: {"conversationId":"c1"}\n\n';

function erroringStream(head: string): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(new Error('terminated'));
        return;
      }
      sent = true;
      if (head !== '') controller.enqueue(new TextEncoder().encode(head));
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function run(reply: () => Response): Promise<string> {
  lines = ['one'];
  vi.stubGlobal('fetch', (url: unknown) =>
    Promise.resolve(new URL(String(url)).pathname === '/chat' ? reply() : Response.json({})),
  );
  const out = captureStdout();
  await chatCommand();
  return out();
}

describe('chat: 応答の途中で接続が切れたときの案内（#4089）', () => {
  it('ターンがデーモンで続いていること・/resume で戻れること・/conversation で読めることを言う', async () => {
    const text = await run(() => erroringStream(OPEN));
    expect(text).toContain('エラー: 応答が途中で切れました（terminated）');
    expect(text).toContain('ターンはデーモンで続いています');
    expect(text).toContain('/resume で戻れます（頭から流れ直すので、見えた分と重なります）');
    expect(text).toContain('完成した返信は /conversation で読めます');
  });

  it('何も受け取る前に切れたときは、ターンが続いているとは言わない', async () => {
    const text = await run(() => erroringStream(''));
    expect(text).toContain('応答が途中で切れました');
    expect(text).not.toContain('ターンはデーモンで続いています');
  });

  it('/resume の再生が切れたときは、いままでの文のまま（案内を重ねない。#3767）', async () => {
    lines = ['/resume c1'];
    vi.stubGlobal('fetch', (url: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path === '/chat/c1/stream') {
        return Promise.resolve(
          erroringStream('event: open\ndata: {"conversationId":"c1","inProgress":true}\n\n'),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    const out = captureStdout();
    await chatCommand();
    const text = out();
    expect(text).not.toContain('ターンはデーモンで続いています');
  });
});

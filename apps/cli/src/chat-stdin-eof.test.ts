import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (orig) => ({
  ...(await orig<typeof import('./target.js')>()),
  resolveTarget: async () => ({
    baseUrl: 'http://127.0.0.1:4517',
    headers: {},
    remote: false,
    note: null,
  }),
}));

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (realStdin !== undefined) Object.defineProperty(process, 'stdin', realStdin);
  syncBuiltinESMExports();
});

describe('chat: 標準入力が EOF になったとき', () => {
  it('質問を打ち切って REPL を抜け、会話の終了（/end）を送る', async () => {
    const input = new PassThrough();
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });
    syncBuiltinESMExports();
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: unknown) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path === '/chat') {
        return Promise.resolve(
          new Response(
            'event: open\ndata: {"conversationId":"c1"}\n\nevent: done\ndata: {"type":"done"}\n\n',
            {
              headers: { 'content-type': 'text/event-stream' },
            },
          ),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    input.write('hello\n');
    await vi.waitFor(() => expect(calls).toContain('/chat'));
    input.end();
    await done;
    out();
    expect(calls).toContain('/chat/c1/end');
  }, 30000);
});

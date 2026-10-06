import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * 標準入力をパイプで渡したときの EOF（#3217）。node v22 では、パイプの EOF で
 * `readline/promises` の `question()` が resolve も reject もされない（端末の Ctrl-D は
 * ABORT_ERR で reject される）。本物の readline に PassThrough を繋いで再現する。
 */
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
    // `chat.ts` は `node:process` から `stdin` を取るので、ESM 側の束縛も同期させる。
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
    // 初回は chat.ts（大きい）の読み込みで既定の5秒を超えうる。
  }, 30000);
});

import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * 標準入力をパイプで複数行まとめて渡したとき（#3262）。1行目の応答を待つ間に届いた
 * 2行目以降が、`question()` に渡らず黙って捨てられていた。本物の readline に PassThrough を繋ぐ。
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

function sse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe('chat: 応答を待つ間に複数行が届いたとき', () => {
  it('捨てずに順に送り、終了時に会話を閉じる', async () => {
    const input = new PassThrough();
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });
    syncBuiltinESMExports();
    const sent: string[] = [];
    const paths: string[] = [];
    let releaseFirst: (() => void) | null = null;
    vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/chat') {
        sent.push((JSON.parse(String(init?.body)) as { text: string }).text);
        const reply = sse(
          'event: open\ndata: {"conversationId":"c1"}\n\nevent: done\ndata: {"type":"done"}\n\n',
        );
        // 1通目の応答だけ遅らせる（その間に2行目・3行目が届く）。
        if (sent.length === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirst = () => {
              resolve(reply);
            };
          });
        }
        return Promise.resolve(reply);
      }
      return Promise.resolve(Response.json({}));
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    input.write('one\n');
    await vi.waitFor(() => expect(releaseFirst).not.toBeNull());
    input.write('two\nthree\n');
    input.end();
    releaseFirst!();
    await done;
    out();
    expect(sent).toEqual(['one', 'two', 'three']);
    expect(paths).toContain('/chat/c1/end');
  }, 30000);
});

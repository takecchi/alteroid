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

  it.each([
    {
      tty: false,
      label: '標準入力が端末でない（パイプ）と、流れてきた yes でも戻せない操作を実行しない',
      stops: 0,
    },
    { tty: true, label: '端末なら、次の行の yes を確認の答えとして読み、実行する', stops: 1 },
  ])(
    '/stop の確認: $label',
    async ({ tty, stops }) => {
      const input = Object.assign(new PassThrough(), { isTTY: tty });
      Object.defineProperty(process, 'stdin', { value: input, configurable: true });
      syncBuiltinESMExports();
      const requests: string[] = [];
      vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
        requests.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
        if (new URL(String(url)).pathname === '/chat') {
          return Promise.resolve(
            sse(
              'event: open\ndata: {"conversationId":"c1"}\n\nevent: done\ndata: {"type":"done"}\n\n',
            ),
          );
        }
        return Promise.resolve(Response.json({}));
      });
      const out = captureStdout();
      const { chatCommand } = await import('./chat.js');
      const done = chatCommand();
      input.write('/stop mgr-1\nyes\n');
      input.end();
      await done;
      const text = out();
      expect(requests.filter((r) => r === 'DELETE /managers/mgr-1')).toHaveLength(stops);
      if (!tty) expect(text).toContain('何も変更していません');
    },
    30000,
  );
});

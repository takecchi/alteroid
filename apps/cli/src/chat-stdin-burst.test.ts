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

  // 1通目の応答を止めたまま、端末の入力を流せる状態にする。
  function ttySession(holdAll = false) {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });
    syncBuiltinESMExports();
    const sent: string[] = [];
    const release: { current: (() => void) | null } = { current: null };
    vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/chat') {
        sent.push((JSON.parse(String(init?.body)) as { text: string }).text);
        const reply = sse(
          'event: open\ndata: {"conversationId":"c1"}\n\nevent: done\ndata: {"type":"done"}\n\n',
        );
        if (sent.length === 1 || holdAll) {
          return new Promise<Response>((resolve) => {
            release.current = () => {
              resolve(reply);
            };
          });
        }
        return Promise.resolve(reply);
      }
      return Promise.resolve(Response.json({}));
    });
    return { input, sent, release };
  }

  it('端末では、応答中に打った行を黙って送らず、次のプロンプトの入力欄に戻して Enter で送る', async () => {
    const { input, sent, release } = ttySession();
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    input.write('one\n');
    await vi.waitFor(() => expect(release.current).not.toBeNull());
    input.write('typed ahead\n');
    release.current!();
    await vi.waitFor(() => expect(out()).toContain('まだ送っていません'));
    expect(sent).toEqual(['one']);
    input.write('\n');
    await vi.waitFor(() => expect(sent).toEqual(['one', 'typed ahead']));
    input.end();
    await done;
    out();
  }, 30000);

  it('端末では、応答中に打った複数行も黙って送らず、Enter で1発言として送る', async () => {
    const { input, sent, release } = ttySession();
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    input.write('one\n');
    await vi.waitFor(() => expect(release.current).not.toBeNull());
    input.write('two\nthree\n');
    release.current!();
    await vi.waitFor(() => expect(out()).toContain('まだ送っていません'));
    expect(sent).toEqual(['one']);
    input.write('\n');
    await vi.waitFor(() => expect(sent).toEqual(['one', 'two\nthree']));
    input.end();
    await done;
    out();
  }, 30000);

  it('端末では、応答中に打った行を送らないまま Ctrl-D で終えても、あとから送らない', async () => {
    const { input, sent, release } = ttySession(true);
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    input.write('one\n');
    await vi.waitFor(() => expect(release.current).not.toBeNull());
    input.write('typed ahead\n');
    input.end();
    release.current!();
    await done;
    out();
    expect(sent).toEqual(['one']);
  }, 30000);

  it('/stop の確認: 端末で先に打った yes は答えにならず、確認の入力欄で改めて打った yes だけが答えになる', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });
    syncBuiltinESMExports();
    const requests: string[] = [];
    vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
      requests.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
      return Promise.resolve(Response.json({}));
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    input.write('/stop mgr-1\nyes\n');
    await vi.waitFor(() => expect(out()).toContain('続けるなら yes'));
    // 答えにされていれば、確認の直後に削除が飛ぶ。飛ばないことを少し待って見る。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests.filter((r) => r === 'DELETE /managers/mgr-1')).toHaveLength(0);
    input.write('yes\n');
    await vi.waitFor(() =>
      expect(requests.filter((r) => r === 'DELETE /managers/mgr-1')).toHaveLength(1),
    );
    input.end();
    await done;
    out();
  }, 30000);

  it.each([
    {
      tty: false,
      label: '標準入力が端末でない（パイプ）と、流れてきた yes でも戻せない操作を実行しない',
      stops: 0,
    },
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

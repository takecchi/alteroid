import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
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

const sse = (body: string): Response =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });

/** `handler` が `fetch` の代わり。呼ばれた（パス, 本文）を積む。 */
async function run(
  input: string[],
  handler: (path: string, call: number) => Promise<Response>,
): Promise<{ calls: { path: string; body: Record<string, unknown> | null }[]; text: string }> {
  lines = [...input];
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const count: Record<string, number> = {};
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({
      path,
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    count[path] = (count[path] ?? 0) + 1;
    return handler(path, count[path]);
  });
  const out = captureStdout();
  await chatCommand();
  return { calls, text: out() };
}

describe('chat: done も error も無いまま閉じたら言う（#3410）', () => {
  it('open のあとで閉じたら、途中で切れたと言う', async () => {
    const { text } = await run(['one'], () =>
      Promise.resolve(
        sse('event: open\ndata: {"conversationId":"c1"}\n\nevent: text\ndata: {"text":"途中"}\n\n'),
      ),
    );
    expect(text).toContain('途中');
    expect(text).toContain('応答が途中で切れました');
  });

  it('open の前に閉じたら、受け取られたか分からないと言う', async () => {
    const { text } = await run(['one'], () => Promise.resolve(sse('')));
    expect(text).toContain('発言が受け取られたかは分かりません');
  });

  it('done で閉じたら言わない', async () => {
    const { text } = await run(['one'], () =>
      Promise.resolve(sse('event: done\ndata: {"type":"done"}\n\n')),
    );
    expect(text).not.toContain('途中で切れました');
    expect(text).not.toContain('受け取られたかは分かりません');
  });
});

describe('chat: 通信の例外で REPL を落とさない（#3218）', () => {
  it('発言の送信が例外（fetch 失敗）でも、1行言って入力に戻り、次の発言を送れる', async () => {
    const { calls, text } = await run(['one', 'two'], (path, call) =>
      path === '/chat' && call === 1
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(sse('event: done\ndata: {"type":"done"}\n\n')),
    );
    expect(text).toContain('エラー: fetch failed');
    expect(calls.filter((c) => c.path === '/chat').map((c) => c.body?.text)).toEqual([
      'one',
      'two',
    ]);
  });

  it('応答の SSE が途中で切れても、会話 id を保って続け、抜けるときに会話を終える', async () => {
    const { calls, text } = await run(['one', 'two'], (path, call) => {
      if (path === '/chat' && call === 1) {
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          // error() は積んだチャンクを捨てるので、1回目の pull で open を渡し、2回目で切る。
          pull(controller) {
            if (sent) {
              controller.error(new Error('terminated'));
              return;
            }
            sent = true;
            controller.enqueue(
              new TextEncoder().encode('event: open\ndata: {"conversationId":"c1"}\n\n'),
            );
          },
        });
        return Promise.resolve(
          new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
        );
      }
      return Promise.resolve(sse('event: done\ndata: {"type":"done"}\n\n'));
    });
    expect(text).toContain('エラー: 応答が途中で切れました（terminated）');
    const chats = calls.filter((c) => c.path === '/chat');
    expect(chats[1]?.body).toMatchObject({ text: 'two', conversationId: 'c1' });
    expect(calls.map((c) => c.path)).toContain('/chat/c1/end');
  });

  it('スラッシュコマンドの通信が例外でも、1行言って入力に戻る', async () => {
    const { calls, text } = await run(['/report', 'after'], (path) =>
      path === '/chat'
        ? Promise.resolve(sse('event: done\ndata: {"type":"done"}\n\n'))
        : Promise.reject(new TypeError('fetch failed')),
    );
    expect(text).toContain('エラー: fetch failed');
    expect(calls.filter((c) => c.path === '/chat').map((c) => c.body?.text)).toEqual(['after']);
  });

  it('送信が例外でも、添えかけ（/attach）は残り、次の送信に載る', async () => {
    const dir = await makeTempDir('alteroid-chat-net-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'x');
    const { calls } = await run([`/attach ${path}`, 'one', ''], (p, call) => {
      if (p === '/chat' && call === 1) return Promise.reject(new TypeError('fetch failed'));
      if (p.includes('/attachments')) {
        return Promise.resolve(
          Response.json({
            id: 'att-1',
            name: 'a.log',
            mediaType: 'text/plain',
            size: 1,
            sha256: 'x',
          }),
        );
      }
      return Promise.resolve(sse('event: done\ndata: {"type":"done"}\n\n'));
    });
    const chats = calls.filter((c) => c.path === '/chat');
    expect(chats).toHaveLength(2);
    expect(chats[1]?.body).toMatchObject({ text: '', attachments: ['att-1'] });
  });
});

import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { captureStdout } from './test-support.js';

/**
 * `chat`（REPL）の応答中でない区間の Ctrl+C（#3818）。クローンの応答を描いている間だけが
 * `POST /clone/interrupt` で、それ以外（スラッシュコマンドの通信待ち・添付のアップロード・`/resume` の探索）は
 * 手元のコマンドだけを abort し、クローンのターンには触れない。偽の readline を使うので実時間の待ちは無い。
 */
class FakeRl extends EventEmitter {
  closed = false;
  prompts = 0;
  setPrompt(): void {}
  prompt(): void {
    this.prompts += 1;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

let rl: FakeRl;
vi.mock('node:readline/promises', () => ({
  createInterface: () => rl,
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

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');

function useStdin(isTTY: boolean): void {
  const input = Object.assign(new PassThrough(), { isTTY });
  Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  syncBuiltinESMExports();
}

beforeEach(() => {
  rl = new FakeRl();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (realStdin !== undefined) Object.defineProperty(process, 'stdin', realStdin);
  syncBuiltinESMExports();
});

const sse = (body: string): Response =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const OK_REPLY =
  'event: open\ndata: {"conversationId":"c1"}\n\nevent: done\ndata: {"type":"done"}\n\n';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** `hang` に当たるパスは、abort されるまで応答しない（abort されたら AbortError で落ちる）。 */
function stubFetch(
  hang: (path: string, method: string) => boolean,
  handler: (path: string) => Response | Promise<Response>,
) {
  const calls: { path: string; method: string; aborted: () => boolean }[] = [];
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    const signal = init?.signal ?? undefined;
    calls.push({ path, method, aborted: () => signal?.aborted === true });
    if (hang(path, method)) {
      return new Promise<Response>((_, reject) => {
        const fail = (): void => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        };
        if (signal?.aborted === true) fail();
        else signal?.addEventListener('abort', fail);
      });
    }
    return Promise.resolve(handler(path));
  });
  return calls;
}

describe('chat: 応答中でない区間の Ctrl+C は手元のコマンドだけを取り消す（#3818）', () => {
  it('スラッシュコマンドの通信待ちの Ctrl+C は、通信を abort し、/clone/interrupt を呼ばない', async () => {
    useStdin(true);
    const calls = stubFetch(
      (path) => path.startsWith('/reports'),
      () => Response.json({}),
    );
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', '/report');
    await flush();
    expect(calls.map((c) => c.path)).toContain('/reports');

    rl.emit('SIGINT');
    await flush();
    expect(calls.map((c) => c.path)).not.toContain('/clone/interrupt');
    expect(calls.find((c) => c.path === '/reports')?.aborted()).toBe(true);
    expect(rl.closed).toBe(false);
    expect(out()).toContain('取り消しました');

    // 入力待ちに戻っている（次の行を受ける）。
    rl.emit('line', '/report');
    await flush();
    rl.emit('SIGINT');
    await flush();
    rl.emit('SIGINT'); // 入力待ちの Ctrl+C は終了
    await done;
    expect(rl.closed).toBe(true);
    expect(calls.map((c) => c.path)).not.toContain('/clone/interrupt');
  });

  it('添付のアップロード中の Ctrl+C は、/chat を呼ばず、送っていないと言う', async () => {
    useStdin(true);
    const dir = await makeTempDir('alteroid-sigint-');
    const file = join(dir, 'a.log');
    await writeFile(file, 'x');
    const calls = stubFetch(
      (path, method) => path === '/attachments' && method === 'POST',
      () => Response.json({}),
    );
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', `/attach ${file}`);
    // 端末では、コマンドの実行中に打った行は送らずに取っておく（#3955）。入力待ちに戻ってから打つ。
    await vi.waitFor(() => {
      expect(rl.prompts).toBeGreaterThanOrEqual(2);
    });
    rl.emit('line', 'これを見て');
    // 周回の数で打ち切らない: ファイル読みは実 I/O なので、混んだ runner では何周回っても終わらないことがある。
    await vi.waitFor(() => {
      expect(calls.some((c) => c.path === '/attachments' && c.method === 'POST')).toBe(true);
    });

    rl.emit('SIGINT');
    await flush();
    const paths = calls.map((c) => c.path);
    expect(paths).not.toContain('/clone/interrupt');
    expect(paths).not.toContain('/chat');
    expect(calls.find((c) => c.path === '/attachments' && c.method === 'POST')?.aborted()).toBe(
      true,
    );
    expect(rl.closed).toBe(false);
    expect(out()).toMatch(/取り消しました.*送っていません/s);

    rl.close();
    await done;
  });

  it('/resume の探索中の Ctrl+C は、探索を abort し、/clone/interrupt を呼ばない', async () => {
    useStdin(true);
    const calls = stubFetch(
      (path) => path === '/chat/c9/stream',
      () => Response.json({}),
    );
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', '/resume c9');
    await flush();
    expect(calls.map((c) => c.path)).toContain('/chat/c9/stream');

    rl.emit('SIGINT');
    await flush();
    expect(calls.map((c) => c.path)).not.toContain('/clone/interrupt');
    expect(calls.find((c) => c.path === '/chat/c9/stream')?.aborted()).toBe(true);
    expect(rl.closed).toBe(false);
    expect(out()).toContain('取り消しました');
    rl.close();
    await done;
  });

  it('（陰性対照）/resume で進行中のターンを再生している間の Ctrl+C は、クローンのターンを止める', async () => {
    useStdin(true);
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    });
    let streams = 0;
    const calls = stubFetch(
      () => false,
      (path) => {
        if (path === '/chat/c9/stream') {
          streams += 1;
          // 1回目は探索（open だけ）、2回目が再生。
          return streams === 1
            ? sse('event: open\ndata: {"conversationId":"c9","inProgress":true}\n\n')
            : sse(body as unknown as string);
        }
        if (path === '/clone/interrupt') return Response.json({ outcome: 'interrupted' });
        return Response.json({});
      },
    );
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', '/resume c9');
    await flush();
    stream.enqueue(
      encoder.encode('event: open\ndata: {"conversationId":"c9","inProgress":true}\n\n'),
    );
    await flush();

    rl.emit('SIGINT');
    await flush();
    expect(calls.map((c) => c.path)).toContain('/clone/interrupt');
    expect(out()).toContain('いま走っていたクローンのターンを止めた');

    stream.enqueue(encoder.encode('event: done\ndata: {"type":"done"}\n\n'));
    stream.close();
    await flush();
    rl.close();
    await done;
  });

  it('返答のあとの既読付けの Ctrl+C は、既読付けだけを取り消し、/clone/interrupt を呼ばない', async () => {
    useStdin(true);
    const calls = stubFetch(
      (path) => path === '/conversations/c1',
      (path) => (path === '/chat' ? sse(OK_REPLY) : Response.json({})),
    );
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', 'hello');
    await flush();
    expect(calls.map((c) => c.path)).toContain('/conversations/c1');

    rl.emit('SIGINT');
    await flush();
    expect(calls.map((c) => c.path)).not.toContain('/clone/interrupt');
    expect(calls.find((c) => c.path === '/conversations/c1')?.aborted()).toBe(true);
    expect(rl.closed).toBe(false);
    expect(out()).toContain('既読付けを取り消しました');
    rl.close();
    await done;
  });

  it('確認の入力欄（yes と入力）の Ctrl+C は、その確認だけを取り消し、REPL は続く（#3954）', async () => {
    useStdin(true);
    const calls = stubFetch(
      () => false,
      () => Response.json({}),
    );
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', '/stop m1');
    await flush();
    expect(out()).toContain('取り消せません。');

    rl.emit('SIGINT');
    await flush();
    expect(rl.closed).toBe(false);
    expect(out()).toContain('取り消しました。何も変更していません。');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    // 確認は片付き、通常の入力待ちに戻っている。そこでの Ctrl+C は今までどおり終了する。
    rl.emit('SIGINT');
    await done;
    expect(rl.closed).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('（陰性対照）確認の入力欄で yes と入力すれば、操作は進む', async () => {
    useStdin(true);
    const calls = stubFetch(
      () => false,
      () => Response.json({}),
    );
    captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', '/stop m1');
    await flush();
    rl.emit('line', 'yes');
    await flush();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    rl.close();
    await done;
  });

  it('（陰性対照）発言の応答の受信中の Ctrl+C は、今どおり /clone/interrupt を呼ぶ', async () => {
    useStdin(true);
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    });
    const calls = stubFetch(
      () => false,
      (path) => {
        if (path === '/chat') return sse(body as unknown as string);
        if (path === '/clone/interrupt') return Response.json({ outcome: 'interrupted' });
        return Response.json({});
      },
    );
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', 'hello');
    await flush();
    stream.enqueue(encoder.encode(OK_REPLY.split('event: done')[0] ?? ''));
    await flush();

    rl.emit('SIGINT');
    await flush();
    expect(calls.map((c) => c.path)).toContain('/clone/interrupt');
    expect(out()).toContain('いま走っていたクローンのターンを止めた');

    stream.enqueue(encoder.encode('event: done\ndata: {"type":"done"}\n\n'));
    stream.close();
    await flush();
    rl.close();
    await done;
  });
});

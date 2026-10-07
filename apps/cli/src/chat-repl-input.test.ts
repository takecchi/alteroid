import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

class FakeRl extends EventEmitter {
  closed = false;
  setPrompt(): void {}
  prompt(): void {}
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
let input: PassThrough & { isTTY?: boolean };

function useStdin(isTTY: boolean): void {
  input = Object.assign(new PassThrough(), { isTTY });
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

function recordFetch(handler: (path: string, text: string | null) => Promise<Response> | Response) {
  const calls: { path: string; text: string | null }[] = [];
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const text =
      path === '/chat' ? (JSON.parse(String(init?.body)) as { text: string }).text : null;
    calls.push({ path, text });
    return Promise.resolve(handler(path, text));
  });
  return calls;
}

describe('chat: 応答中の Ctrl+C（#3411）', () => {
  it('応答中は /clone/interrupt を呼んで REPL を続け、閉じない', async () => {
    useStdin(true);
    let release: (() => void) | null = null;
    let chats = 0;
    const calls = recordFetch((path) => {
      if (path === '/chat') {
        chats += 1;
        if (chats > 1) return sse(OK_REPLY);
        // 会話が分かっている（open を受けた）あとの応答待ち。対象の発言を指して止める（#3956）。
        const [opened, rest] = OK_REPLY.split('event: done');
        return sse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(opened ?? ''));
              release = () => {
                controller.enqueue(new TextEncoder().encode(`event: done${rest ?? ''}`));
                controller.close();
              };
            },
          }) as unknown as string,
        );
      }
      if (path === '/clone/interrupt') return Response.json({ outcome: 'interrupted' });
      return Response.json({});
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', 'hello');
    await flush();
    expect(release).not.toBeNull();

    rl.emit('SIGINT');
    await flush();
    expect(calls.map((c) => c.path)).toContain('/clone/interrupt');
    expect(rl.closed).toBe(false);

    release!();
    await flush();
    expect(rl.closed).toBe(false);
    rl.emit('line', 'again');
    await flush();
    rl.close();
    await done;
    const text = out();
    expect(text).toContain('いま走っていたクローンのターンを止めた');
    expect(calls.filter((c) => c.path === '/chat').map((c) => c.text)).toEqual(['hello', 'again']);
    expect(calls.filter((c) => c.path === '/chat/c1/end')).toHaveLength(1);
  });

  it.each([
    [
      '止められたとき',
      () => Response.json({ outcome: 'interrupted' }),
      'いま走っていたクローンのターンを止めた',
    ],
    ['止められなかったとき', () => Response.json({ error: 'boom' }, { status: 500 }), 'エラー:'],
  ])(
    '行の途中（改行前の断片が溜まっている間）に止めたら、%s、断片を書き切ってから止めた文を出す（#3769）',
    async (_name, interruptResponse, notice) => {
      useStdin(true);
      const encoder = new TextEncoder();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      });
      recordFetch((path) => {
        if (path === '/chat') return sse(body as unknown as string);
        if (path === '/clone/interrupt') return interruptResponse();
        return Response.json({});
      });
      const out = captureStdout();
      const { chatCommand } = await import('./chat.js');
      const done = chatCommand();
      await flush();
      rl.emit('line', 'hello');
      await flush();
      stream.enqueue(
        encoder.encode(
          'event: open\ndata: {"conversationId":"c1"}\n\n' +
            'event: text\ndata: {"text":"こんにちは、今日は"}\n\n',
        ),
      );
      await flush();
      expect(out()).not.toContain('こんにちは、今日は');

      rl.emit('SIGINT');
      await flush();
      const text = out();
      expect(text).toContain('こんにちは、今日は');
      expect(text).toContain(notice);
      expect(text.indexOf('こんにちは、今日は')).toBeLessThan(text.indexOf(notice));
      expect(text).toMatch(new RegExp(`こんにちは、今日は\\n+[^\\n]*${notice}`));

      stream.enqueue(encoder.encode('event: done\ndata: {"type":"done"}\n\n'));
      stream.close();
      await flush();
      rl.close();
      await done;
    },
  );

  it('止められなかったら理由を言い、REPL は続ける', async () => {
    useStdin(true);
    let release: (() => void) | null = null;
    recordFetch((path) => {
      if (path === '/chat') {
        const [opened, rest] = OK_REPLY.split('event: done');
        return sse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(opened ?? ''));
              release = () => {
                controller.enqueue(new TextEncoder().encode(`event: done${rest ?? ''}`));
                controller.close();
              };
            },
          }) as unknown as string,
        );
      }
      if (path === '/clone/interrupt') return Response.json({ error: 'boom' }, { status: 500 });
      return Response.json({});
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', 'hello');
    await flush();
    rl.emit('SIGINT');
    await flush();
    expect(rl.closed).toBe(false);
    release!();
    await flush();
    rl.close();
    await done;
    expect(out()).toContain('クローンのターンを止められませんでした');
  });

  it('入力を待っている間の Ctrl+C は、今まで通り終了する', async () => {
    useStdin(true);
    const calls = recordFetch(() => Response.json({}));
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('SIGINT');
    await done;
    out();
    expect(rl.closed).toBe(true);
    expect(calls.map((c) => c.path)).not.toContain('/clone/interrupt');
  });
});

describe('chat: 複数行の入力（#3412）', () => {
  it('貼り付けの複数行は1発言になり、次の Enter で送る', async () => {
    useStdin(true);
    const calls = recordFetch((path) => (path === '/chat' ? sse(OK_REPLY) : Response.json({})));
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    input.emit('keypress', undefined, { name: 'paste-start' });
    rl.emit('line', '以下を直して');
    rl.emit('line', 'func main() {');
    input.emit('keypress', undefined, { name: 'paste-end' });
    await flush();
    expect(calls.filter((c) => c.path === '/chat')).toHaveLength(0);
    rl.emit('line', '}');
    await flush();
    rl.close();
    await done;
    out();
    expect(calls.filter((c) => c.path === '/chat').map((c) => c.text)).toEqual([
      '以下を直して\nfunc main() {\n}',
    ]);
  });

  it('// で始まる行は発言なので、行末の \\ で続けられる（#3768）', async () => {
    useStdin(true);
    const calls = recordFetch((path) => (path === '/chat' ? sse(OK_REPLY) : Response.json({})));
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', '//tmp/a を見て\\');
    await flush();
    expect(calls.filter((c) => c.path === '/chat')).toHaveLength(0);
    rl.emit('line', '二行目');
    await flush();
    rl.close();
    await done;
    out();
    expect(calls.filter((c) => c.path === '/chat').map((c) => c.text)).toEqual([
      '/tmp/a を見て\n二行目',
    ]);
  });

  it('行末の \\ で次の行へ続け、/ で始まる行は続けない', async () => {
    useStdin(true);
    const calls = recordFetch((path) => (path === '/chat' ? sse(OK_REPLY) : Response.json({})));
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', '一行目\\');
    await flush();
    expect(calls.filter((c) => c.path === '/chat')).toHaveLength(0);
    rl.emit('line', '二行目');
    await flush();
    rl.emit('line', '/attach C:\\dir\\');
    await flush();
    rl.close();
    await done;
    const text = out();
    expect(calls.filter((c) => c.path === '/chat').map((c) => c.text)).toEqual(['一行目\n二行目']);
    expect(text).not.toContain('エラー: input closed');
  });

  it('続きの途中で入力が閉じたら、そこまでを1発言として送る', async () => {
    useStdin(false);
    const calls = recordFetch((path) => (path === '/chat' ? sse(OK_REPLY) : Response.json({})));
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', '途中\\');
    rl.close();
    await done;
    out();
    expect(calls.filter((c) => c.path === '/chat').map((c) => c.text)).toEqual(['途中']);
  });
});

describe('chat: 打った本文を書き換えずに送る（#3952）', () => {
  async function sendLines(lines: string[]): Promise<(string | null)[]> {
    useStdin(true);
    const calls = recordFetch((path) => (path === '/chat' ? sse(OK_REPLY) : Response.json({})));
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    for (const line of lines) {
      rl.emit('line', line);
      await flush();
    }
    rl.close();
    await done;
    out();
    return calls.filter((c) => c.path === '/chat').map((c) => c.text);
  }

  it('行末の \\\\ は1文字の \\ として送る', async () => {
    expect(await sendLines(['path C:\\\\'])).toEqual(['path C:\\']);
  });

  it('奇数個なら、半分に畳んだうえで続ける', async () => {
    expect(await sendLines(['a\\\\\\', 'b'])).toEqual(['a\\\nb']);
  });

  it('続きの行の末尾の \\\\ も畳む', async () => {
    expect(await sendLines(['x\\', 'C:\\\\'])).toEqual(['x\nC:\\']);
  });

  it('/ で始まるコマンドの \\\\ は触らない', async () => {
    useStdin(true);
    const calls = recordFetch(() => Response.json({}));
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', '/attach C:\\\\');
    await flush();
    rl.close();
    await done;
    expect(out()).toContain('C:\\\\');
    expect(calls.filter((c) => c.path === '/chat')).toHaveLength(0);
  });

  it('1行目の先頭の空白を保つ（末尾の空白・改行は落とす）', async () => {
    expect(await sendLines(['  indented first  '])).toEqual(['  indented first']);
  });

  it('貼り付けでも1行目のインデントを保つ', async () => {
    useStdin(true);
    const calls = recordFetch((path) => (path === '/chat' ? sse(OK_REPLY) : Response.json({})));
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    input.emit('keypress', undefined, { name: 'paste-start' });
    rl.emit('line', '    if (x) {');
    rl.emit('line', '    }');
    input.emit('keypress', undefined, { name: 'paste-end' });
    await flush();
    rl.emit('line', '');
    await flush();
    rl.close();
    await done;
    out();
    expect(calls.filter((c) => c.path === '/chat').map((c) => c.text)).toEqual([
      '    if (x) {\n    }',
    ]);
  });

  it('空白だけの行は送らず、先頭に空白のある // も発言として送る', async () => {
    expect(await sendLines(['   ', '  //tmp/a'])).toEqual(['  /tmp/a']);
  });
});

describe('chat: 非対話の入力で送信が失敗したら止まる（#3413）', () => {
  it('失敗した行で止まり、会話を閉じて、投げる（残りの行は送らない）', async () => {
    useStdin(false);
    const calls = recordFetch((path, text) => {
      if (path === '/chat' && text === 'hello') return sse(OK_REPLY);
      if (path === '/chat') return Response.json({ error: 'busy' }, { status: 503 });
      return Response.json({});
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    const settled = done.then(
      () => null,
      (error: unknown) => error as Error,
    );
    await flush();
    rl.emit('line', 'hello');
    await flush();
    rl.emit('line', '503 a');
    await flush();
    rl.emit('line', 'third');
    await flush();
    const error = await settled;
    out();
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('送信に失敗した');
    expect(error?.message).toContain('busy');
    expect(calls.filter((c) => c.path === '/chat').map((c) => c.text)).toEqual(['hello', '503 a']);
    expect(calls.filter((c) => c.path === '/chat/c1/end')).toHaveLength(1);
  });

  it.each([
    ['不明なコマンド', '/reprot', '不明なコマンド'],
    ['使い方の誤り', '/answer', '使い方の誤り'],
  ])('非対話では、%s の行で止まり、残りは送らず、投げる（#3768）', async (_name, bad, reason) => {
    useStdin(false);
    const calls = recordFetch(() => sse(OK_REPLY));
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    const settled = done.then(
      () => null,
      (error: unknown) => error as Error,
    );
    await flush();
    rl.emit('line', bad);
    await flush();
    rl.emit('line', 'hello');
    await flush();
    const error = await settled;
    out();
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(bad);
    expect(error?.message).toContain(reason);
    expect(calls.filter((c) => c.path === '/chat')).toEqual([]);
  });

  it.each([
    ['不明なコマンド', '/reprot'],
    ['使い方の誤り', '/answer'],
  ])('端末なら、%s は案内を出して続ける（止めない）（#3768）', async (_name, bad) => {
    useStdin(true);
    const calls = recordFetch(() => sse(OK_REPLY));
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', bad);
    await flush();
    rl.emit('line', 'hello');
    await flush();
    rl.close();
    await done;
    out();
    expect(calls.filter((c) => c.path === '/chat').map((c) => c.text)).toEqual(['hello']);
  });

  it('// で始めた行は、先頭の / を 1 つ外した発言として送る（TUI と同じ。#3768）', async () => {
    useStdin(false);
    const calls = recordFetch(() => sse(OK_REPLY));
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', '//var/log/app.log を見て');
    await flush();
    rl.emit('line', '///x');
    await flush();
    rl.close();
    await done;
    out();
    expect(calls.filter((c) => c.path === '/chat').map((c) => c.text)).toEqual([
      '/var/log/app.log を見て',
      '//x',
    ]);
  });

  it('端末なら、失敗しても1行言って入力へ戻る（終了コードは変えない）', async () => {
    useStdin(true);
    const calls = recordFetch((path, text) => {
      if (path === '/chat' && text === '503 a')
        return Response.json({ error: 'busy' }, { status: 503 });
      return path === '/chat' ? sse(OK_REPLY) : Response.json({});
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', '503 a');
    await flush();
    rl.emit('line', 'second');
    await flush();
    rl.close();
    await done;
    out();
    expect(calls.filter((c) => c.path === '/chat').map((c) => c.text)).toEqual(['503 a', 'second']);
  });
});

describe('chat: 未送信の表示とスラッシュコマンドの失敗', () => {
  it('貼り付けのあと、まだ送っていないと1行言う（末尾の改行を含んでも）', async () => {
    useStdin(true);
    const calls = recordFetch((path) => (path === '/chat' ? sse(OK_REPLY) : Response.json({})));
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    input.emit('keypress', undefined, { name: 'paste-start' });
    rl.emit('line', 'a');
    rl.emit('line', 'b');
    rl.emit('line', '');
    input.emit('keypress', undefined, { name: 'paste-end' });
    await flush();
    const text = out();
    expect(text).toContain('貼り付けた 3 行。まだ送っていません。Enter で送信');
    expect(calls.filter((c) => c.path === '/chat')).toHaveLength(0);
    rl.close();
    await done;
  });

  it('非対話では、スラッシュコマンドの通信が失敗したら止まり、後続を送らない', async () => {
    useStdin(false);
    const calls = recordFetch((path) => {
      if (path === '/chat') return sse(OK_REPLY);
      if (path === '/reports') return Response.json({ error: 'down' }, { status: 500 });
      return Response.json({});
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    const settled = done.then(
      () => null,
      (error: unknown) => error as Error,
    );
    await flush();
    rl.emit('line', '/reports');
    await flush();
    rl.emit('line', 'hello');
    await flush();
    const error = await settled;
    out();
    expect(error?.message).toContain('/reports');
    expect(error?.message).toContain('HTTP 500');
    expect(calls.filter((c) => c.path === '/chat')).toHaveLength(0);
  });

  it('端末なら、スラッシュコマンドが失敗しても続ける', async () => {
    useStdin(true);
    const calls = recordFetch((path) => {
      if (path === '/chat') return sse(OK_REPLY);
      if (path === '/reports') return Response.json({ error: 'down' }, { status: 500 });
      return Response.json({});
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', '/reports');
    await flush();
    rl.emit('line', 'hello');
    await flush();
    rl.close();
    await done;
    out();
    expect(calls.filter((c) => c.path === '/chat').map((c) => c.text)).toEqual(['hello']);
  });
});

describe('continuesLine', () => {
  it('奇数個の \\ で終わるときだけ続ける', async () => {
    const { continuesLine } = await import('./chat.js');
    expect(continuesLine('a\\')).toBe(true);
    expect(continuesLine('a\\\\')).toBe(false);
    expect(continuesLine('a\\\\\\')).toBe(true);
    expect(continuesLine('a')).toBe(false);
    expect(continuesLine('')).toBe(false);
  });
});

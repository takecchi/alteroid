import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStderr, captureStdout } from './test-support.js';

/**
 * #4087: 端末で Ctrl-D（入力の終わり）にしたとき、まだ送っていない書きかけは送らず捨てる。
 * 偽の readline と偽の標準入力を使うので、実時間の待ちは無い。
 */
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

const OK_REPLY =
  'event: open\ndata: {"conversationId":"c1"}\n\nevent: done\ndata: {"type":"done"}\n\n';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function recordChats(): string[] {
  const texts: string[] = [];
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/chat') {
      texts.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return Promise.resolve(
        new Response(OK_REPLY, { headers: { 'content-type': 'text/event-stream' } }),
      );
    }
    return Promise.resolve(Response.json({}));
  });
  return texts;
}

async function start(): Promise<{ done: Promise<void> }> {
  const { chatCommand } = await import('./chat.js');
  const done = chatCommand();
  await flush();
  return { done };
}

describe('chat: 端末での Ctrl-D は書きかけを送らず、捨てたと言う（#4087）', () => {
  it('貼り付けた未送信の本文を送らない', async () => {
    useStdin(true);
    const chats = recordChats();
    const out = captureStdout();
    const err = captureStderr();
    const { done } = await start();
    input.emit('keypress', undefined, { name: 'paste-start' });
    rl.emit('line', 'rm -rf build');
    rl.emit('line', 'echo done');
    input.emit('keypress', undefined, { name: 'paste-end' });
    rl.close();
    await done;
    out();
    expect(chats).toEqual([]);
    expect(err()).toContain('（書きかけの入力を捨てました。送っていません）');
  });

  it('`\\` の続きの途中の行を送らない', async () => {
    useStdin(true);
    const chats = recordChats();
    const out = captureStdout();
    const err = captureStderr();
    const { done } = await start();
    rl.emit('line', '書きかけ\\');
    rl.close();
    await done;
    out();
    expect(chats).toEqual([]);
    expect(err()).toContain('（書きかけの入力を捨てました。送っていません）');
  });

  it('書きかけが無ければ、何も言わずに終わる', async () => {
    useStdin(true);
    recordChats();
    const out = captureStdout();
    const err = captureStderr();
    const { done } = await start();
    rl.close();
    await done;
    out();
    expect(err()).not.toContain('捨てました');
  });
});

describe('chat: パイプの入力の終わりは今まで通り、そこまでを1発言として渡す（#3217）', () => {
  it('`\\` の続きの途中で閉じたら送る', async () => {
    useStdin(false);
    const chats = recordChats();
    const out = captureStdout();
    const err = captureStderr();
    const { done } = await start();
    rl.emit('line', '途中\\');
    rl.close();
    await done;
    out();
    expect(chats).toEqual(['途中']);
    expect(err()).not.toContain('捨てました');
  });
});

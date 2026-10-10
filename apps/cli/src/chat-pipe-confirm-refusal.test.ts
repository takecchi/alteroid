import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * パイプで確認できずに実行しなかった戻せない操作は、失敗として止める。
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
const DONE = 'event: done\ndata: {"type":"done"}\n\n';

interface Call {
  method: string;
  path: string;
  text: unknown;
}

function recordFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? 'GET', path, text: body?.text });
    return Promise.resolve(path === '/chat' ? sse(DONE) : Response.json({}));
  });
  return calls;
}

async function start(): Promise<{ settled: Promise<Error | null> }> {
  const { chatCommand } = await import('./chat.js');
  const settled = chatCommand().then(
    () => null,
    (error: unknown) => error as Error,
  );
  await vi.waitFor(() => expect(rl.listenerCount('line')).toBeGreaterThan(0));
  return { settled };
}

describe('#3993: 非 TTY で確認できずに実行しなかった /stop・/archive remove', () => {
  for (const command of ['/stop m1', '/archive remove s1']) {
    it(`${command}: 失敗として止まり、実行せず、後続の行を送らない。理由に実行していないことと手段を書く`, async () => {
      useStdin(false);
      const calls = recordFetch();
      const out = captureStdout();
      const { settled } = await start();
      rl.emit('line', command);
      rl.emit('line', '次の発言');
      // 止まらない実装でも試験が待ち続けないよう、入力の終わりを置く
      rl.close();
      const error = await settled;
      out();
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain(command.split(' ')[0]);
      expect(error?.message).toContain('実行していない');
      expect(error?.message).toContain('端末');
      expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
      expect(calls.filter((c) => c.path === '/chat')).toEqual([]);
    });
  }

  it('存在しない単発コマンドの --yes を案内しない', async () => {
    useStdin(false);
    recordFetch();
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', '/stop m1');
    rl.close();
    const error = await settled;
    const text = out();
    expect(error).toBeInstanceOf(Error);
    expect(String(error?.message)).not.toContain('--yes');
    expect(text).not.toContain('--yes');
  });
});

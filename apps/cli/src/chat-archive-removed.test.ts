import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * #4023: 本文を消した生ログ（410）を、失敗でなく「いつ消したか・何バイトだったか」として言い、パイプでも止めない。
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

function recordFetch(routes: Record<string, () => Response>): string[] {
  const chats: string[] = [];
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/chat') {
      const body = JSON.parse(String(init?.body)) as { text: string };
      chats.push(body.text);
      return Promise.resolve(sse(DONE));
    }
    return Promise.resolve(routes[path]?.() ?? Response.json({}, { status: 500 }));
  });
  return chats;
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

const removed = (extra: Record<string, unknown> = {}): Response =>
  Response.json(
    { error: 'removed', removedAt: '2026-08-21T00:00:00.000Z', bytes: 4096, ...extra },
    { status: 410 },
  );

describe('#4023: 本文を消した生ログ（410）', () => {
  const cases: [string, string, string, () => Response][] = [
    [
      '/manager mgr1',
      '/managers/mgr1/transcript',
      'そのマネージャーの生ログは',
      () => removed({ archiveId: 'arc-1' }),
    ],
    ['/archive arc-1', '/archive/arc-1', 'その生ログは', () => removed()],
  ];
  for (const [line, path, subject, respond] of cases) {
    it(`${line}: いつ消したか・何バイトだったかを言い、失敗の文にしない`, async () => {
      useStdin(true);
      recordFetch({ [path]: respond });
      const out = captureStdout();
      await start();
      rl.emit('line', line);
      await vi.waitFor(() => expect(out()).toContain('2026-08-21T00:00:00.000Z'));
      rl.close();
      const text = out();
      expect(text).toContain(subject);
      expect(text).toContain('本文を消しました');
      expect(text).toContain('4096バイト');
      expect(text).not.toContain('読めませんでした');
      expect(text).not.toContain('removed');
    });

    it(`${line}: 非 TTY でも止めず、次の行へ進む`, async () => {
      useStdin(false);
      const chats = recordFetch({ [path]: respond });
      const out = captureStdout();
      const { settled } = await start();
      rl.emit('line', line);
      rl.emit('line', '次の発言');
      rl.close();
      const error = await settled;
      expect(out()).toContain('本文を消しました');
      expect(error).toBeNull();
      expect(chats).toEqual(['次の発言']);
    });
  }

  it('/manager: 消した本文の archiveId があれば言う', async () => {
    useStdin(true);
    recordFetch({ '/managers/mgr1/transcript': () => removed({ archiveId: 'arc-1' }) });
    const out = captureStdout();
    await start();
    rl.emit('line', '/manager mgr1');
    await vi.waitFor(() => expect(out()).toContain('arc-1'));
    rl.close();
  });

  it('410 の本文が読めなくても、削除済みと言い、止めない', async () => {
    useStdin(false);
    const chats = recordFetch({
      '/archive/arc-1': () => new Response('<html>', { status: 410 }),
    });
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', '/archive arc-1');
    rl.emit('line', '次の発言');
    rl.close();
    const error = await settled;
    expect(out()).toContain('本文が削除済み');
    expect(error).toBeNull();
    expect(chats).toEqual(['次の発言']);
  });

  it('/archive: 410 でなく 500 なら、今まで通り止まる', async () => {
    useStdin(false);
    const chats = recordFetch({
      '/archive/arc-1': () => Response.json({ error: 'x' }, { status: 500 }),
    });
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', '/archive arc-1');
    rl.emit('line', '次の発言');
    rl.close();
    const error = await settled;
    out();
    expect(String(error?.message)).toContain('/archive が失敗した');
    expect(chats).toEqual([]);
  });
});

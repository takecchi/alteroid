import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * #3994: パイプで、付随の取得（未読の総数・会話の承認）が非 2xx なだけなら止めない。
 * 本体の取得が失敗したときは、今まで通り止める。偽の readline と偽の標準入力を使うので、実時間の待ちは無い。
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

const LIST = { conversations: [], scanned: 0, reachedStart: true, hiddenByLimit: 0 };
const CONVERSATION = { messages: [], scanned: 0, reachedStart: true, supersededCount: 0 };

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

describe('#3994: 非 TTY の付随の取得の失敗は止めない', () => {
  for (const status of [503, 404]) {
    it(`/conversations: 未読の総数が ${String(status)} でも、一覧は出て、次の行へ進む`, async () => {
      useStdin(false);
      const chats = recordFetch({
        '/conversations': () => Response.json(LIST),
        '/conversations/unread-count': () => Response.json({ error: 'x' }, { status }),
      });
      const out = captureStdout();
      const { settled } = await start();
      rl.emit('line', '/conversations');
      rl.emit('line', '次の発言');
      rl.close();
      const error = await settled;
      const text = out();
      expect(text).toContain('未読のある会話の総数は取れませんでした');
      expect(error).toBeNull();
      expect(chats).toEqual(['次の発言']);
    });
  }

  it('/conversation: 承認の取得が 503 でも、会話は出て、次の行へ進む', async () => {
    useStdin(false);
    const chats = recordFetch({
      '/conversations/c1': () => Response.json(CONVERSATION),
      '/approvals': () => Response.json({ error: 'x' }, { status: 503 }),
    });
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', '/conversation c1');
    rl.emit('line', '次の発言');
    rl.close();
    const error = await settled;
    out();
    expect(error).toBeNull();
    expect(chats).toEqual(['次の発言']);
  });

  it('本体の取得（/conversations の一覧）が失敗したら、今まで通り止まる', async () => {
    useStdin(false);
    const chats = recordFetch({
      '/conversations': () => Response.json({ error: 'x' }, { status: 503 }),
      '/conversations/unread-count': () => Response.json({ count: 0, capped: false }),
    });
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', '/conversations');
    rl.emit('line', '次の発言');
    rl.close();
    const error = await settled;
    out();
    expect(error).toBeInstanceOf(Error);
    expect(String(error?.message)).toContain('/conversations が失敗した');
    expect(chats).toEqual([]);
  });

  it('本体の取得（/conversation）が失敗したら、今まで通り止まる', async () => {
    useStdin(false);
    const chats = recordFetch({
      '/conversations/c1': () => Response.json({ error: 'x' }, { status: 503 }),
      '/approvals': () => Response.json({ approvals: [], unreadable: [] }),
    });
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', '/conversation c1');
    rl.emit('line', '次の発言');
    rl.close();
    const error = await settled;
    out();
    expect(error).toBeInstanceOf(Error);
    expect(String(error?.message)).toContain('/conversation が失敗した');
    expect(chats).toEqual([]);
  });
});

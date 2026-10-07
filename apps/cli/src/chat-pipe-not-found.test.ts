import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * #4002: パイプで、「無い」を正常な結果として文にしている 404 は止めない。
 * 指した対象が見つからない 404（使い手の指定の誤り）は、今まで通り止める。偽の readline と偽の標準入力を使うので、実時間の待ちは無い。
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

const notFound = (): Response => Response.json({ error: 'not found' }, { status: 404 });

describe('#4002: 非 TTY で「無い」を正常な結果として出す 404 は止めない', () => {
  const cases: [string, string, string, string][] = [
    ['/report 2026-01-01', '/reports/2026-01-01', '2026-01-01 の日報はありません', '/report'],
    ['/memory note', '/memory/note', 'そんな記憶はありません', '/memory'],
  ];
  for (const [line, path, sentence] of cases) {
    it(`${line}: 404 は「無い」と言い、次の行へ進む`, async () => {
      useStdin(false);
      const chats = recordFetch({ [path]: notFound });
      const out = captureStdout();
      const { settled } = await start();
      rl.emit('line', line);
      rl.emit('line', '次の発言');
      rl.close();
      const error = await settled;
      const text = out();
      expect(text).toContain(sentence);
      expect(error).toBeNull();
      expect(chats).toEqual(['次の発言']);
    });
  }

  it('/report: 404 でなく 500 なら、今まで通り止まる', async () => {
    useStdin(false);
    const chats = recordFetch({
      '/reports/2026-01-01': () => Response.json({ error: 'x' }, { status: 500 }),
    });
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', '/report 2026-01-01');
    rl.emit('line', '次の発言');
    rl.close();
    const error = await settled;
    out();
    expect(error).toBeInstanceOf(Error);
    expect(String(error?.message)).toContain('/report が失敗した');
    expect(chats).toEqual([]);
  });

  it('/conversation: 指した会話が 404 なら（使い手の指定の誤り）、今まで通り止まる', async () => {
    useStdin(false);
    const chats = recordFetch({ '/conversations/c1': notFound });
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', '/conversation c1');
    rl.emit('line', '次の発言');
    rl.close();
    const error = await settled;
    expect(out()).toContain('そんな会話はありません');
    expect(error).toBeInstanceOf(Error);
    expect(String(error?.message)).toContain('/conversation が失敗した');
    expect(chats).toEqual([]);
  });

  it('/unschedule: 指した依頼が 404 なら、今まで通り止まる', async () => {
    useStdin(false);
    const chats = recordFetch({ '/schedule/nope': notFound });
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', '/unschedule nope');
    rl.emit('line', '次の発言');
    rl.close();
    const error = await settled;
    out();
    expect(error).toBeInstanceOf(Error);
    expect(String(error?.message)).toContain('/unschedule が失敗した');
    expect(chats).toEqual([]);
  });
});

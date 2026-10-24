import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * パイプで、書き込み系のコマンドに一覧に無い番号を渡したら止める（#4795）。偽の readline と偽の標準入力を使うので、実時間の待ちは無い。
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

describe('非対話で、書き込み系のコマンドに一覧に無い番号を渡したら止まる（#4795）', () => {
  const lines = [
    '/msg 3 やって',
    '/stop 3',
    '/done 3',
    '/commit-edit 3 直した本文',
    '/commit-reopen 3 まだ終わっていない',
    '/edit 3 直した本文',
    '/reply 3 返事',
    '/allow 3',
    '/deny 3',
  ];
  for (const line of lines) {
    it(`⭐ ${line}: 一覧に無いと言って止まり、次の行を送らない`, async () => {
      useStdin(false);
      const chats = recordFetch({});
      const out = captureStdout();
      const { settled } = await start();
      rl.emit('line', line);
      rl.emit('line', '次の発言');
      rl.close();
      const error = await settled;
      out();
      expect(error).toBeInstanceOf(Error);
      expect(chats).toEqual([]);
    });
  }

  it('⭐ 複数行の /edit が始まらなかったら止まり、編集のつもりの次の行を新しい発言として送らない', async () => {
    useStdin(false);
    const chats = recordFetch({});
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', '/edit 3');
    rl.emit('line', '直した本文');
    rl.close();
    const error = await settled;
    expect(out()).toContain('一覧にありません');
    expect(error).toBeInstanceOf(Error);
    expect(chats).toEqual([]);
  });

  // 一覧に在る番号でも、サーバが 404・409・5xx で断った回は失敗である（#5236）。成功の回は止まらない。
  // 注意: パイプの停止そのものは通信の口（chatCommand の localFetch）が先に `HTTP <status>` で立てるので、この節は
  // 「止まる・止まらない」の回帰を測る。文を onFailed に渡すこと自体の歯は chat.test.ts 側（runSlashCommand）にある。
  describe('HTTP の失敗（#5236）', () => {
    const ENTRY = {
      id: 'cmt-1',
      at: '2026-08-16T12:00:00.000Z',
      origin: 'human',
      body: 'ドキュメントの誤りを直す',
    };
    const writes = [
      { line: '/done 1 片付けた', path: '/commitments/cmt-1/close' },
      { line: '/commit-edit 1 直した本文', path: '/commitments/cmt-1' },
      { line: '/commit 積む本文', path: '/commitments', method: 'POST' },
    ];

    function recordLedgerFetch(status: number, path: string, method: string): string[] {
      const chats: string[] = [];
      vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
        const target = new URL(String(url)).pathname;
        if (target === '/chat') {
          const body = JSON.parse(String(init?.body)) as { text: string };
          chats.push(body.text);
          return Promise.resolve(sse(DONE));
        }
        const requested = init?.method ?? 'GET';
        if (target === '/commitments' && requested === 'GET') {
          return Promise.resolve(Response.json({ entries: [ENTRY] }));
        }
        if (target === path && requested === method) {
          return Promise.resolve(
            Response.json(status === 200 ? {} : { error: 'サーバが断った' }, { status }),
          );
        }
        return Promise.resolve(Response.json({}, { status: 500 }));
      });
      return chats;
    }

    for (const {
      line,
      path,
      method = line.startsWith('/commit-edit') ? 'PATCH' : 'POST',
    } of writes) {
      for (const status of [404, 409, 500]) {
        it(`⭐ ${line}（${status}）: 失敗として止まり、次の行を送らない`, async () => {
          useStdin(false);
          const chats = recordLedgerFetch(status, path, method);
          const out = captureStdout();
          const { settled } = await start();
          rl.emit('line', '/commitments');
          rl.emit('line', line);
          rl.emit('line', '次の発言');
          rl.close();
          const error = await settled;
          out();
          expect(error).toBeInstanceOf(Error);
          expect(error?.message).toContain(`コマンド ${line.split(' ')[0] ?? ''} が失敗した`);
          expect(chats).toEqual([]);
        });
      }

      it(`対照: ${line}（成功）: 止まらず、次の行を送る`, async () => {
        useStdin(false);
        const chats = recordLedgerFetch(200, path, method);
        const out = captureStdout();
        const { settled } = await start();
        rl.emit('line', '/commitments');
        rl.emit('line', line);
        rl.emit('line', '次の発言');
        rl.close();
        const error = await settled;
        out();
        expect(error).toBeNull();
        expect(chats).toEqual(['次の発言']);
      });
    }
  });

  // 会話を開いていない /edit は送る前に止まる回で、通信の口が先に失敗を立てない。onFailed に渡さないと、止まらず次の行を送る（#5240）
  it('⭐ /edit: 会話を開いていなければ止まり、次の行を送らない', async () => {
    useStdin(false);
    const chats = recordFetch({});
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', '/edit m1 直した本文');
    rl.emit('line', '次の発言');
    rl.close();
    const error = await settled;
    expect(out()).toContain('先に /conversation');
    expect(error).toBeInstanceOf(Error);
    expect(chats).toEqual([]);
  });

  // id を直に書く書き込み系の、サーバが断った回（#5240）。成功の回は止まらない。
  // 注意: #5236 の節と同じく、パイプの停止そのものは通信の口が先に立てる。文を onFailed に渡す歯は chat.test.ts 側にある。
  describe('HTTP の失敗（#5240）', () => {
    const writes = [
      { line: '/schedule daily-x 09:00 本文', path: '/schedule', method: 'POST' },
      { line: '/unschedule daily-x', path: '/schedule/daily-x', method: 'DELETE' },
      { line: '/run daily-x', path: '/schedule/daily-x/run', method: 'POST' },
      { line: '/event ci ビルドが落ちた', path: '/events', method: 'POST' },
      { line: '/msg mgr-1 やって', path: '/managers/mgr-1/messages', method: 'POST' },
      // /stop・/archive remove は非対話では確認が取れず、HTTP に届く前に止まる（#3141）ので、ここには並べない
    ];

    function recordWriteFetch(status: number, path: string, method: string): string[] {
      const chats: string[] = [];
      vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
        const target = new URL(String(url)).pathname;
        if (target === '/chat') {
          const body = JSON.parse(String(init?.body)) as { text: string };
          chats.push(body.text);
          return Promise.resolve(sse(DONE));
        }
        if (target === path && (init?.method ?? 'GET') === method) {
          return Promise.resolve(
            Response.json(
              status === 200 ? { outcome: 'delivered', detail: 'ok' } : { error: 'サーバが断った' },
              { status },
            ),
          );
        }
        return Promise.resolve(Response.json({}, { status: 500 }));
      });
      return chats;
    }

    for (const { line, path, method } of writes) {
      for (const status of [404, 409, 500]) {
        it(`⭐ ${line}（${status}）: 失敗として止まり、次の行を送らない`, async () => {
          useStdin(false);
          const chats = recordWriteFetch(status, path, method);
          const out = captureStdout();
          const { settled } = await start();
          rl.emit('line', line);
          rl.emit('line', '次の発言');
          rl.close();
          const error = await settled;
          out();
          expect(error).toBeInstanceOf(Error);
          expect(error?.message).toContain(`コマンド ${line.split(' ')[0] ?? ''} が失敗した`);
          expect(chats).toEqual([]);
        });
      }

      it(`対照: ${line}（成功）: 止まらず、次の行を送る`, async () => {
        useStdin(false);
        const chats = recordWriteFetch(200, path, method);
        const out = captureStdout();
        const { settled } = await start();
        rl.emit('line', line);
        rl.emit('line', '次の発言');
        rl.close();
        const error = await settled;
        out();
        expect(error).toBeNull();
        expect(chats).toEqual(['次の発言']);
      });
    }
  });

  it('対照: 読み取り系（/manager）は一覧に無いと言うだけで止まらない', async () => {
    useStdin(false);
    const chats = recordFetch({});
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', '/manager 3');
    rl.emit('line', '次の発言');
    rl.close();
    const error = await settled;
    out();
    expect(error).toBeNull();
    expect(chats).toEqual(['次の発言']);
  });
});

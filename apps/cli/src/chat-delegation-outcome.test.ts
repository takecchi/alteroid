import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * #4022: デーモンが HTTP 200 で返す「届かなかった・止まらなかった・一部失敗」を成功として扱わない。
 * 偽の readline・偽の標準入力・偽の fetch だけを使うので、実時間の待ちは無い。
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

const sse = (body: string): Response =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const OK_REPLY =
  'event: open\ndata: {"conversationId":"c1"}\n\nevent: done\ndata: {"type":"done"}\n\n';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

interface Call {
  path: string;
  body: Record<string, unknown> | null;
}
function recordFetch(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const call = { path, body };
    calls.push(call);
    return Promise.resolve(handler(call));
  });
  return calls;
}

const chats = (calls: Call[]) => calls.filter((c) => c.path === '/chat').map((c) => c.body?.text);

const base = 'http://127.0.0.1:4517';
const target = { baseUrl: base, headers: {}, remote: false, note: null };
const listed = {
  approvals: [],
  managerAnchors: {},
  commitments: [],
  conversations: [],
  managers: [],
  waiting: [{ managerId: 'mgr1', requestId: 'r1' }],
  messages: [],
  messagesConversationId: 'c1',
  messageAttachments: {},
  messageTexts: {},
} as unknown as Parameters<typeof import('./chat.js').runSlashCommand>[2];

async function runOnce(
  line: string,
  respond: (call: Call) => Response,
): Promise<{ reasons: string[]; text: string }> {
  recordFetch(respond);
  const out = captureStdout();
  const { runSlashCommand } = await import('./chat.js');
  const { createClient } = await import('./client.js');
  const reasons: string[] = [];
  await runSlashCommand(
    line,
    createClient(base, {}),
    listed,
    null,
    target,
    async () => true,
    (reason) => reasons.push(reason),
  );
  return { reasons, text: out() };
}

const outcome = (value: string) => () =>
  Response.json({ outcome: value, detail: `詳細（${value}）` });

describe('#4022: 200 の outcome が成功でなければ失敗として知らせる', () => {
  const lines = ['/msg mgr1 hello', '/reply r1 hello', '/allow r1', '/deny r1', '/allow'];

  for (const line of lines) {
    for (const value of ['delivered', 'answered']) {
      it(`${line} は ${value} なら失敗にしない`, async () => {
        const { reasons, text } = await runOnce(line, (call) =>
          call.path === '/managers'
            ? Response.json({ managers: [{ managerId: 'mgr1', waiting: [{ requestId: 'r1' }] }] })
            : outcome(value)(),
        );
        expect(reasons).toEqual([]);
        expect(text).toContain(`${value}: 詳細（${value}）`);
        expect(text).not.toContain('✗');
      });
    }

    for (const value of ['session_missing', 'declined']) {
      it(`${line} は ${value} なら失敗として知らせる`, async () => {
        const { reasons, text } = await runOnce(line, (call) =>
          call.path === '/managers'
            ? Response.json({ managers: [{ managerId: 'mgr1', waiting: [{ requestId: 'r1' }] }] })
            : outcome(value)(),
        );
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toContain(`詳細（${value}）`);
        expect(text).toContain(`✗ ${value}: 詳細（${value}）`);
      });
    }
  }

  it('/stop は stopped だけを成功にする', async () => {
    const ok = await runOnce('/stop mgr1', outcome('stopped'));
    expect(ok.reasons).toEqual([]);
    expect(ok.text).not.toContain('✗');
    for (const value of ['not_stopped', 'unknown']) {
      const failed = await runOnce('/stop mgr1', outcome(value));
      expect(failed.reasons).toHaveLength(1);
      expect(failed.text).toContain(`✗ ${value}: 詳細（${value}）`);
    }
  });

  it('/answers は1件でも失敗したら、全件を出したうえで失敗として知らせる', async () => {
    const { reasons, text } = await runOnce('/answers a1 はい a2 いいえ', () =>
      Response.json({
        results: [
          { id: 'a1', ok: true },
          { id: 'a2', ok: false, error: '既に決着している' },
        ],
      }),
    );
    expect(text).toContain('[a1] 回答しました');
    expect(text).toContain('[a2] 回答に失敗: 既に決着している');
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('a2');
    expect(reasons[0]).not.toContain('a1');
  });

  it('/answers は全件通れば失敗にしない', async () => {
    const { reasons } = await runOnce('/answers a1 はい', () =>
      Response.json({ results: [{ id: 'a1', ok: true }] }),
    );
    expect(reasons).toEqual([]);
  });
});

describe('#4022: パイプでは止め、端末では続ける', () => {
  const reply = (call: Call): Response =>
    call.path === '/chat'
      ? sse(OK_REPLY)
      : Response.json({ outcome: 'session_missing', detail: '届いていない' });

  async function start() {
    const { chatCommand } = await import('./chat.js');
    const settled = chatCommand().then(
      () => null,
      (error: unknown) => error as Error,
    );
    await flush();
    return { settled };
  }

  it('非 TTY では /msg が session_missing なら止まり、後続を送らない', async () => {
    useStdin(false);
    const calls = recordFetch(reply);
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', '/msg mgr1 hello');
    rl.emit('line', 'next');
    const error = await settled;
    out();
    expect(error?.message).toContain('/msg');
    expect(error?.message).toContain('届いていない');
    expect(chats(calls)).toEqual([]);
  });

  it('端末では /msg が session_missing でも続ける', async () => {
    useStdin(true);
    const calls = recordFetch(reply);
    const out = captureStdout();
    await start();
    rl.emit('line', '/msg mgr1 hello');
    await vi.waitFor(() => expect(out()).toContain('session_missing'));
    rl.emit('line', 'next');
    await vi.waitFor(() => expect(chats(calls)).toEqual(['next']));
    rl.close();
    await flush();
  });
});

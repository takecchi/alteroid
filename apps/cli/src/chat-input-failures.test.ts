import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStderr, captureStdout } from './test-support.js';

/**
 * chat の修正（#3682〜#3686）。偽の readline と偽の標準入力を使うので、実時間の待ちは無い。
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
const OPEN = 'event: open\ndata: {"conversationId":"c1"}\n\n';
const DONE = 'event: done\ndata: {"type":"done"}\n\n';
const OK_REPLY = `${OPEN}${DONE}`;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

interface Call {
  path: string;
  body: Record<string, unknown> | null;
}
function recordFetch(handler: (call: Call) => Promise<Response> | Response): Call[] {
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

async function start() {
  const { chatCommand } = await import('./chat.js');
  const done = chatCommand();
  const settled = done.then(
    () => null,
    (error: unknown) => error as Error,
  );
  await flush();
  return { settled };
}

const chats = (calls: Call[]) => calls.filter((c) => c.path === '/chat').map((c) => c.body?.text);

describe('#3683: 本文の改行・インデント・連続した空白を潰さない', () => {
  it('rawTail は先頭のトークンと区切りだけを落とす', async () => {
    const { rawTail } = await import('./chat.js');
    expect(rawTail('/msg abc 直して:\n  if x:\n      y', 2)).toBe('直して:\n  if x:\n      y');
    expect(rawTail('/commit   a  b', 1)).toBe('a  b');
    expect(rawTail('/stop 1', 2)).toBe('');
    expect(rawTail('/done 1 末尾の空白  \n', 2)).toBe('末尾の空白');
  });

  it('/commit の本文がそのまま POST される', async () => {
    useStdin(true);
    const calls = recordFetch(() => Response.json({}));
    const out = captureStdout();
    await start();
    rl.emit('line', '/commit 直して:\n  if x:\n      y  z');
    await flush();
    rl.close();
    await flush();
    out();
    expect(calls.find((c) => c.path === '/commitments')?.body?.body).toBe(
      '直して:\n  if x:\n      y  z',
    );
  });

  it('/msg・/edit の本文もそのまま送られる', async () => {
    const calls = recordFetch(() => Response.json({ outcome: 'ok', detail: '' }));
    const out = captureStdout();
    const { runSlashCommand } = await import('./chat.js');
    const { createClient } = await import('./client.js');
    const base = 'http://127.0.0.1:4517';
    const listed = {
      approvals: [],
      managerAnchors: {},
      commitments: [],
      conversations: [],
      managers: [],
      waiting: [],
      messages: ['m1'],
      messagesConversationId: 'c1',
      messageAttachments: {},
      messageTexts: {},
    };
    await runSlashCommand(
      '/msg mgr1 直して:\n  if x:\n      y',
      createClient(base, {}),
      listed,
      null,
      { baseUrl: base, headers: {}, remote: false, note: null },
    );
    await runSlashCommand('/edit 1 新しい:\n    本文  です', createClient(base, {}), listed, null, {
      baseUrl: base,
      headers: {},
      remote: false,
      note: null,
    });
    out();
    expect(calls.find((c) => c.path.endsWith('/messages'))?.body?.text).toBe(
      '直して:\n  if x:\n      y',
    );
    expect(calls.find((c) => c.path === '/chat')?.body?.text).toBe('新しい:\n    本文  です');
  });
});

describe('#3685: 非 TTY の /edit・/resume・/attach・/detach の失敗で止まる', () => {
  for (const command of ['/attach /nonexistent/file.txt', '/detach 9', '/resume c9']) {
    it(`非 TTY では ${command} が失敗したら止まり、後続を送らない`, async () => {
      useStdin(false);
      const calls = recordFetch(({ path }) =>
        path === '/chat' ? sse(OK_REPLY) : Response.json({ error: 'down' }, { status: 500 }),
      );
      const out = captureStdout();
      const { settled } = await start();
      rl.emit('line', command);
      rl.emit('line', 'hello');
      const error = await settled;
      out();
      expect(error?.message).toContain(command.split(' ')[0]);
      expect(chats(calls)).toEqual([]);
    });

    it(`端末なら ${command} が失敗しても続ける`, async () => {
      useStdin(true);
      const calls = recordFetch(({ path }) =>
        path === '/chat' ? sse(OK_REPLY) : Response.json({ error: 'down' }, { status: 500 }),
      );
      const out = captureStdout();
      await start();
      rl.emit('line', command);
      await vi.waitFor(() => expect(out()).toMatch(/添えられません|外せません|エラー/));
      rl.emit('line', 'hello');
      await vi.waitFor(() => expect(chats(calls)).toEqual(['hello']));
      rl.close();
      await flush();
    });
  }

  it('/edit が失敗したことを onFailed で返す', async () => {
    recordFetch(() => Response.json({ error: 'bad' }, { status: 400 }));
    const out = captureStdout();
    const { runSlashCommand } = await import('./chat.js');
    const { createClient } = await import('./client.js');
    const base = 'http://127.0.0.1:4517';
    const reasons: string[] = [];
    await runSlashCommand(
      '/edit m1 本文',
      createClient(base, {}),
      {
        approvals: [],
        managerAnchors: {},
        commitments: [],
        conversations: [],
        managers: [],
        waiting: [],
        messages: [],
        messagesConversationId: 'c1',
        messageAttachments: {},
        messageTexts: {},
      },
      null,
      { baseUrl: base, headers: {}, remote: false, note: null },
      undefined,
      (reason) => reasons.push(reason),
    );
    out();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('bad');
  });
});

describe('#3682: Ctrl+C は書きかけを送らず捨てる', () => {
  it('`\\` の続きの途中で SIGINT しても送らない', async () => {
    useStdin(true);
    const calls = recordFetch(() => sse(OK_REPLY));
    const out = captureStdout();
    const err = captureStderr();
    await start();
    rl.emit('line', '途中\\');
    rl.emit('SIGINT');
    await flush();
    out();
    expect(err()).toContain('捨てました');
    expect(rl.closed).toBe(true);
    expect(chats(calls)).toEqual([]);
  });

  it('貼り付けの途中（未送信）で SIGINT しても送らない', async () => {
    useStdin(true);
    const calls = recordFetch(() => sse(OK_REPLY));
    const out = captureStdout();
    captureStderr();
    await start();
    input.emit('keypress', undefined, { name: 'paste-start' });
    rl.emit('line', 'a');
    rl.emit('line', 'b');
    input.emit('keypress', undefined, { name: 'paste-end' });
    rl.emit('SIGINT');
    await flush();
    out();
    expect(chats(calls)).toEqual([]);
  });

  it('Ctrl-D（close）は今まで通り途中分を送る', async () => {
    useStdin(true);
    const calls = recordFetch(() => sse(OK_REPLY));
    const out = captureStdout();
    await start();
    rl.emit('line', '途中\\');
    rl.close();
    await flush();
    out();
    expect(chats(calls)).toEqual(['途中']);
  });
});

describe('#3684: 非 TTY で応答が error・切断・usage_limited で終わったら止まる', () => {
  const cases: [string, string][] = [
    ['SSE の error', `${OPEN}event: error\ndata: {"message":"boom"}\n\n`],
    ['done の来ない切断', `${OPEN}event: text\ndata: {"text":"途中"}\n\n`],
    ['usage_limited', `${OPEN}event: usage_limited\ndata: {"message":"上限です"}\n\n`],
  ];
  for (const [name, reply] of cases) {
    it(`${name}: 非 TTY では止まって投げ、後続を送らない`, async () => {
      useStdin(false);
      const calls = recordFetch(() => sse(reply));
      const out = captureStdout();
      const { settled } = await start();
      rl.emit('line', 'one');
      await flush();
      rl.emit('line', 'two');
      await flush();
      const error = await settled;
      out();
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain('送信に失敗した');
      expect(chats(calls)).toEqual(['one']);
    });

    it(`${name}: 端末なら続ける`, async () => {
      useStdin(true);
      const calls = recordFetch(() => sse(reply));
      const out = captureStdout();
      await start();
      rl.emit('line', 'one');
      await flush();
      rl.emit('line', 'two');
      await flush();
      rl.close();
      await flush();
      out();
      expect(chats(calls)).toEqual(['one', 'two']);
    });
  }

  it('usage_limited では、発言が保持されることを理由に書く', async () => {
    useStdin(false);
    recordFetch(() => sse(`${OPEN}event: usage_limited\ndata: {"message":"上限です"}\n\n`));
    const out = captureStdout();
    const { settled } = await start();
    rl.emit('line', 'one');
    await flush();
    const error = await settled;
    out();
    expect(error?.message).toContain('保持されていて、あとで配り直される');
  });
});

describe('#3686: 送れなかった本文を端末へ戻す', () => {
  it('非 2xx のとき、複数行の本文をそのまま標準エラーへ出す（非 TTY）', async () => {
    useStdin(false);
    recordFetch(() => Response.json({ error: 'busy' }, { status: 503 }));
    const out = captureStdout();
    const err = captureStderr();
    const { settled } = await start();
    rl.emit('line', '一行目\\');
    rl.emit('line', '  二行目\x1b[31m');
    await flush();
    await settled;
    out();
    expect(err()).toContain('送れなかった本文:\n一行目\n  二行目\x1b[31m\n');
  });

  it('例外のとき、端末では標準出力へ戻す', async () => {
    useStdin(true);
    vi.stubGlobal('fetch', () => Promise.reject(new Error('fetch failed')));
    const out = captureStdout();
    await start();
    rl.emit('line', 'hello');
    await flush();
    rl.close();
    await flush();
    expect(out()).toContain('送れなかった本文:\nhello\n');
  });

  it('サーバが受けたあとの失敗（SSE error）では再掲しない', async () => {
    useStdin(true);
    recordFetch(() => sse(`${OPEN}event: error\ndata: {"message":"boom"}\n\n`));
    const out = captureStdout();
    await start();
    rl.emit('line', 'hello');
    await flush();
    rl.close();
    await flush();
    expect(out()).not.toContain('送れなかった本文');
  });
});

describe('#3723: /schedule の依頼文と /answer の補足も改行・連続した空白を潰さない', () => {
  const base = 'http://127.0.0.1:4517';
  const target = { baseUrl: base, headers: {}, remote: false, note: null };
  const listed = {
    approvals: [],
    managerAnchors: {},
    commitments: [],
    conversations: [],
    managers: [],
    waiting: [],
    messages: [],
    messagesConversationId: null,
    messageAttachments: {},
    messageTexts: {},
  };
  const run = async (line: string, calls: Call[]) => {
    const out = captureStdout();
    const { runSlashCommand } = await import('./chat.js');
    const { createClient } = await import('./client.js');
    await runSlashCommand(line, createClient(base, {}), listed, null, target);
    out();
    return calls;
  };

  it('/schedule（HH:MM・分ごと）の依頼文がそのまま送られる', async () => {
    for (const [when, spec] of [
      ['09:00', { type: 'daily', at: '09:00' }],
      ['30m', { type: 'every', minutes: 30 }],
    ] as const) {
      const calls = recordFetch(() => Response.json({}));
      await run(`/schedule check ${when} 直して:\n  if x:\n      y  z  `, calls);
      const body = calls.find((c) => c.path === '/schedule')?.body;
      expect(body?.request).toBe('直して:\n  if x:\n      y  z');
      expect(body?.spec).toEqual(spec);
    }
  });

  it('/schedule cron の依頼文がそのまま送られ、式は5項目のまま', async () => {
    const calls = recordFetch(() => Response.json({}));
    await run('/schedule check cron 0  10 * * 1 週次:\n    まとめ  て', calls);
    const body = calls.find((c) => c.path === '/schedule')?.body;
    expect(body?.request).toBe('週次:\n    まとめ  て');
    expect(body?.spec).toEqual({ type: 'cron', expression: '0 10 * * 1' });
  });

  it('/answer の補足がそのまま送られる（フラグを挟むと空白1つ）', async () => {
    const calls = recordFetch(({ path }) =>
      path === '/approvals/a1'
        ? Response.json({
            approval: { id: 'a1', questions: [{ id: 'q1', question: 'q', options: [] }] },
          })
        : Response.json({}),
    );
    await run('/answer a1 --select q1=x 補足:\n  1行目  です  --other q2=あ  末尾  ', calls);
    expect(calls.find((c) => c.path === '/approvals/a1/answer')?.body?.answer).toBe(
      '補足:\n  1行目  です 末尾',
    );
    const calls2 = recordFetch(({ path }) =>
      path === '/approvals/a1'
        ? Response.json({
            approval: { id: 'a1', questions: [{ id: 'q1', question: 'q', options: [] }] },
          })
        : Response.json({}),
    );
    await run('/answer a1 前  置き\n  --select q1=x 後ろ  です', calls2);
    expect(calls2.find((c) => c.path === '/approvals/a1/answer')?.body?.answer).toBe(
      '前  置き 後ろ  です',
    );
  });
});

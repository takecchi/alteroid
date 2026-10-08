import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { captureStderr, captureStdout } from './test-support.js';

/**
 * `chat`（REPL）の応答中の Ctrl+C は、いま送った発言だけを対象にして `POST /clone/interrupt` を呼ぶ（#3956）。
 * 順番待ちの間に先客のターンを止めない。偽の readline・偽の fetch を使うので実時間の待ちは無い。
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

beforeEach(() => {
  rl = new FakeRl();
  const input = Object.assign(new PassThrough(), { isTTY: true });
  Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  syncBuiltinESMExports();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (realStdin !== undefined) Object.defineProperty(process, 'stdin', realStdin);
  syncBuiltinESMExports();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

const encoder = new TextEncoder();
const OPEN = 'event: open\ndata: {"conversationId":"c1"}\n\n';
const QUEUED = 'event: queued\ndata: {"type":"queued"}\n\n';
const DONE = 'event: done\ndata: {"type":"done"}\n\n';

interface Call {
  path: string;
  body: Record<string, unknown> | null;
  aborted: () => boolean;
}

/**
 * `/chat` は、呼ばれた順に `chats` の本文を流す。`hold` が真なら本文を閉じず（先客の待ち）、
 * 実際の fetch と同じく signal が abort されたら本文を AbortError で落とす。
 */
function stubDaemon(options: {
  chats: { events: string; hold: boolean }[];
  interrupt: { outcome: string }[];
}) {
  const calls: Call[] = [];
  const chats = [...options.chats];
  const interrupts = [...options.interrupt];
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const signal = init?.signal ?? undefined;
    calls.push({
      path,
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      aborted: () => signal?.aborted === true,
    });
    if (path === '/chat') {
      const next = chats.shift() ?? { events: DONE, hold: false };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(next.events));
          if (!next.hold) controller.close();
          else {
            signal?.addEventListener('abort', () => {
              controller.error(new DOMException('This operation was aborted', 'AbortError'));
            });
          }
        },
      });
      return Promise.resolve(
        new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      );
    }
    if (path === '/clone/interrupt') {
      return Promise.resolve(Response.json(interrupts.shift() ?? { outcome: 'idle' }));
    }
    if (path === '/attachments' && init?.method === 'POST') {
      const name = new URL(String(url)).searchParams.get('name') ?? 'x';
      return Promise.resolve(
        Response.json({ id: `att-${name}`, name, mediaType: 'text/plain', size: 1, sha256: 'x' }),
      );
    }
    return Promise.resolve(Response.json({}));
  });
  return calls;
}

const interruptsOf = (calls: Call[]): Call[] => calls.filter((c) => c.path === '/clone/interrupt');
const chatsOf = (calls: Call[]): Call[] => calls.filter((c) => c.path === '/chat');

describe('chat: 応答中の Ctrl+C は、いま送った発言を対象にする（#3956）', () => {
  it('順番待ちの間の Ctrl+C は、会話と clientMessageId を付けて呼び、取り下げたらストリームを閉じて本文を戻し、送り直しは新しい clientMessageId', async () => {
    const calls = stubDaemon({
      chats: [
        { events: OPEN + QUEUED, hold: true },
        { events: OPEN + DONE, hold: false },
      ],
      interrupt: [{ outcome: 'withdrawn' }],
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', 'こんにちは');
    await flush();

    rl.emit('SIGINT');
    await flush();

    const sent = chatsOf(calls)[0];
    const interrupt = interruptsOf(calls)[0];
    expect(sent?.body?.clientMessageId).toEqual(expect.any(String));
    expect(interrupt?.body).toEqual({
      conversationId: 'c1',
      clientMessageId: sent?.body?.clientMessageId,
    });
    expect(sent?.aborted()).toBe(true);
    expect(out()).toMatch(/順番待ちだった発言を取り下げました（送っていません）/);
    expect(out()).not.toContain('エラー');
    expect(out()).not.toContain('途中で切れました');
    expect(out()).toMatch(/送れなかった本文:\s*こんにちは/);
    expect(rl.closed).toBe(false);

    // 入力待ちに戻っていて、同じ本文を送り直せる。取り下げた id での再送は重複として受理されるので、新しい id。
    rl.emit('line', 'こんにちは');
    await flush();
    const resent = chatsOf(calls)[1];
    expect(resent?.body?.conversationId).toBe('c1');
    expect(resent?.body?.clientMessageId).toEqual(expect.any(String));
    expect(resent?.body?.clientMessageId).not.toBe(sent?.body?.clientMessageId);

    rl.close();
    await done;
  });

  it('その発言のターンが走っていれば止めた旨を言い、ストリームは閉じない（終端は流れてくる）', async () => {
    const calls = stubDaemon({
      chats: [{ events: OPEN + QUEUED, hold: true }],
      interrupt: [{ outcome: 'interrupted' }],
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', 'hello');
    await flush();
    rl.emit('SIGINT');
    await flush();

    expect(interruptsOf(calls)).toHaveLength(1);
    expect(chatsOf(calls)[0]?.aborted()).toBe(false);
    expect(out()).toContain('いま走っていたクローンのターンを止めた');
    expect(out()).not.toContain('送れなかった本文');
    // 終端が流れてこないまま終わらせる（未解決の待ちを残さない）。
    rl.close();
    void done.catch(() => undefined);
  });

  it('別の起点のターンが走っているなら、先客のターンは止めていないと言う', async () => {
    const calls = stubDaemon({
      chats: [{ events: OPEN + QUEUED, hold: true }],
      interrupt: [{ outcome: 'not_target' }],
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', 'hello');
    await flush();
    rl.emit('SIGINT');
    await flush();

    expect(chatsOf(calls)[0]?.aborted()).toBe(false);
    expect(out()).toContain('先客のターンは止めていません');
    rl.close();
    void done.catch(() => undefined);
  });

  it('starting なら、もう一度押すよう言い、次の Ctrl+C でもう一度呼ぶ', async () => {
    const calls = stubDaemon({
      chats: [{ events: OPEN + QUEUED, hold: true }],
      interrupt: [{ outcome: 'starting' }, { outcome: 'interrupted' }],
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', 'hello');
    await flush();
    rl.emit('SIGINT');
    await flush();
    expect(out()).toContain('もう一度 Ctrl+C');

    rl.emit('SIGINT');
    await flush();
    expect(interruptsOf(calls)).toHaveLength(2);
    expect(interruptsOf(calls)[1]?.body).toEqual(interruptsOf(calls)[0]?.body);
    rl.close();
    void done.catch(() => undefined);
  });

  it('新しい会話で、会話がまだ分からない（open の前）の Ctrl+C は、何も止めず、呼ばない', async () => {
    const calls = stubDaemon({
      chats: [{ events: '', hold: true }],
      interrupt: [],
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', 'hello');
    await flush();
    rl.emit('SIGINT');
    await flush();

    expect(interruptsOf(calls)).toHaveLength(0);
    expect(out()).toContain('何も止めていません');
    rl.close();
    void done.catch(() => undefined);
  });
});

type Pending = { clientMessageId: string; state: string };

/**
 * `/resume c9` の再生。`GET /chat/c9/stream` は呼ばれるたびに `open`（`pending` を載せるか省くか）だけを流して
 * 閉じずに待ち、signal が abort されたら本文を落とす。`streams` は張った接続（最後が再生の接続）。
 */
async function resumeAndInterrupt(options: {
  open: { inProgress: boolean; pending?: Pending[] };
  interrupt: { outcome: string }[];
  /** 偽なら、再生の接続には `open` を流さずに Ctrl+C を押す。 */
  opened?: boolean;
}) {
  const calls = stubDaemon({ chats: [], interrupt: options.interrupt });
  const streams: { aborted: () => boolean }[] = [];
  vi.stubGlobal(
    'fetch',
    ((original: typeof fetch) => (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/chat/c9/stream') {
        const signal = init?.signal ?? undefined;
        streams.push({ aborted: () => signal?.aborted === true });
        const isProbe = streams.length === 1;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                if (options.opened !== false || isProbe) {
                  controller.enqueue(
                    encoder.encode(
                      `event: open\ndata: ${JSON.stringify({ conversationId: 'c9', ...options.open })}\n\n`,
                    ),
                  );
                }
                signal?.addEventListener('abort', () => {
                  controller.error(new DOMException('This operation was aborted', 'AbortError'));
                });
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      }
      return original(url as string, init);
    })(globalThis.fetch),
  );
  const out = captureStdout();
  const { chatCommand } = await import('./chat.js');
  const done = chatCommand();
  await flush();
  rl.emit('line', '/resume c9');
  await flush();
  rl.emit('SIGINT');
  await flush();
  const finish = (): void => {
    rl.close();
    void done.catch(() => undefined);
  };
  return { calls, out, streams, finish };
}

describe('/resume の再生中の Ctrl+C は、open の pending から対象を決める（#3990）', () => {
  it('running が複数（まとめ読み）なら、その先頭の1件を対象に付けて呼ぶ。順番待ちの発言は対象にしない', async () => {
    const { calls, out, finish } = await resumeAndInterrupt({
      open: {
        inProgress: true,
        pending: [
          { clientMessageId: 'm-run1', state: 'running' },
          { clientMessageId: 'm-run2', state: 'running' },
          { clientMessageId: 'm-queued', state: 'queued' },
        ],
      },
      interrupt: [{ outcome: 'interrupted' }],
    });

    expect(interruptsOf(calls)).toHaveLength(1);
    expect(interruptsOf(calls)[0]?.body).toEqual({
      conversationId: 'c9',
      clientMessageId: 'm-run1',
    });
    expect(out()).toContain('いま走っていたクローンのターンを止めた');
    finish();
  });

  it('running が無く starting があれば、starting を対象にする', async () => {
    const { calls, finish } = await resumeAndInterrupt({
      open: {
        inProgress: true,
        pending: [
          { clientMessageId: 'm-start', state: 'starting' },
          { clientMessageId: 'm-held', state: 'held' },
        ],
      },
      interrupt: [{ outcome: 'starting' }],
    });
    expect(interruptsOf(calls)[0]?.body).toEqual({
      conversationId: 'c9',
      clientMessageId: 'm-start',
    });
    finish();
  });

  it('withdrawn なら再生のストリームを閉じ、切断のエラーは出さず、送れなかった本文の戻しも出さない', async () => {
    const { calls, out, streams, finish } = await resumeAndInterrupt({
      open: {
        inProgress: true,
        pending: [{ clientMessageId: 'm-run', state: 'running' }],
      },
      interrupt: [{ outcome: 'withdrawn' }],
    });
    expect(interruptsOf(calls)).toHaveLength(1);
    // 探す接続と再生の接続。再生の側が閉じられている。
    expect(streams.at(-1)?.aborted()).toBe(true);
    expect(out()).toContain('順番待ちだった発言を取り下げました（送っていません）');
    expect(out()).not.toContain('途中で切れました');
    expect(out()).not.toContain('接続が切れました');
    expect(out()).not.toContain('送れなかった本文');
    finish();
  });

  it('not_target なら、先客のターンは止めていないと言う', async () => {
    const { out, finish } = await resumeAndInterrupt({
      open: {
        inProgress: true,
        pending: [{ clientMessageId: 'm-run', state: 'running' }],
      },
      interrupt: [{ outcome: 'not_target' }],
    });
    expect(out()).toContain('先客のターンは止めていません');
    finish();
  });

  it('走っているのが別の起点（pending は順番待ちだけ）なら、順番待ちを取り下げに行かず、呼ばずに対象が分からないと言う', async () => {
    const { calls, out, finish } = await resumeAndInterrupt({
      open: {
        inProgress: true,
        pending: [
          { clientMessageId: 'm-held', state: 'held' },
          { clientMessageId: 'm-queued', state: 'queued' },
        ],
      },
      interrupt: [{ outcome: 'withdrawn' }],
    });
    expect(interruptsOf(calls)).toHaveLength(0);
    expect(out()).toContain('止める対象が分からない');
    finish();
  });

  it('inProgress なのに pending が空なら、呼ばずに対象が分からないと言う', async () => {
    const { calls, out, finish } = await resumeAndInterrupt({
      open: { inProgress: true, pending: [] },
      interrupt: [{ outcome: 'interrupted' }],
    });
    expect(interruptsOf(calls)).toHaveLength(0);
    expect(out()).toContain('止める対象が分からない');
    finish();
  });

  it('古いデーモン（pending を返さない）では、対象を省いて先客のターンを止めないよう、呼ばずに言う', async () => {
    const { calls, out, finish } = await resumeAndInterrupt({
      open: { inProgress: true },
      interrupt: [{ outcome: 'interrupted' }],
    });
    expect(interruptsOf(calls)).toHaveLength(0);
    expect(out()).toContain('止める対象が分からない');
    finish();
  });

  it('再生の open がまだ届いていない間の Ctrl+C は、何も止めず、呼ばない', async () => {
    const { calls, out, finish } = await resumeAndInterrupt({
      open: { inProgress: true, pending: [{ clientMessageId: 'm-run', state: 'running' }] },
      interrupt: [{ outcome: 'interrupted' }],
      opened: false,
    });
    expect(interruptsOf(calls)).toHaveLength(0);
    expect(out()).toContain('何も止めていません');
    finish();
  });
});

describe('chat: 取り下げた発言に添付があれば、戻っていないことを言う（#4046）', () => {
  const FILES_NOTE =
    /添えていたファイル（2 件: a\.log, b\.log）は戻っていません.*\/attach で添え直/s;

  async function attachTwo(): Promise<string[]> {
    const dir = await makeTempDir('alteroid-chat-withdrawn-');
    const paths = [join(dir, 'a.log'), join(dir, 'b.log')];
    for (const path of paths) await writeFile(path, 'x');
    return paths;
  }

  async function withdrawWithFiles(
    lines: string[],
    stdinIsTty: boolean,
    read: () => string,
  ): Promise<{ calls: Call[]; done: Promise<unknown> }> {
    Object.defineProperty(process.stdin, 'isTTY', { value: stdinIsTty, configurable: true });
    const calls = stubDaemon({
      chats: [{ events: OPEN + QUEUED, hold: true }],
      interrupt: [{ outcome: 'withdrawn' }],
    });
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    let attached = 0;
    for (const line of lines) {
      rl.emit('line', line);
      // 添付の読み込みは実 I/O なので、周回の数でなく出力で待つ。
      if (line.startsWith('/attach')) {
        attached += 1;
        await vi.waitFor(() => expect(read()).toContain(`添えかけ ${attached} 件`));
      }
    }
    await vi.waitFor(() => expect(chatsOf(calls)).toHaveLength(1));
    await vi.waitFor(() => expect(chatsOf(calls)[0]?.body?.attachments).toBeDefined());
    rl.emit('SIGINT');
    await vi.waitFor(() => expect(chatsOf(calls)[0]?.aborted()).toBe(true));
    return { calls, done };
  }

  it('端末: 取り下げた文と一緒に、添えていたファイルの名前と件数、/attach で添え直すことを言う', async () => {
    const [a, b] = await attachTwo();
    const out = captureStdout();
    const { calls, done } = await withdrawWithFiles(
      [`/attach ${a}`, `/attach ${b}`, 'これ見て'],
      true,
      out,
    );
    await vi.waitFor(() => expect(out()).toMatch(/送れなかった本文:\s*これ見て/));
    expect(out()).toMatch(FILES_NOTE);
    // 添えかけには戻っていない（言っている通りの状態）。
    expect(chatsOf(calls)[0]?.body?.attachments).toEqual(['att-a.log', 'att-b.log']);
    rl.close();
    await done;
  });

  it('パイプ: 同じ文を（端末ではなく）標準エラーへ出す', async () => {
    const [a, b] = await attachTwo();
    const out = captureStdout();
    const err = captureStderr();
    const { done } = await withdrawWithFiles(
      [`/attach ${a}`, `/attach ${b}`, 'これ見て'],
      false,
      out,
    );
    await vi.waitFor(() => expect(err()).toMatch(/送れなかった本文:\s*これ見て/));
    expect(err()).toMatch(FILES_NOTE);
    expect(out()).not.toMatch(FILES_NOTE);
    rl.close();
    await done;
  });

  it('添付だけの発言（本文が空）でも言う', async () => {
    const [a, b] = await attachTwo();
    const out = captureStdout();
    const { done } = await withdrawWithFiles([`/attach ${a}`, `/attach ${b}`, ''], true, out);
    await vi.waitFor(() => expect(out()).toMatch(FILES_NOTE));
    expect(out()).not.toContain('送れなかった本文');
    rl.close();
    await done;
  });

  it('/edit の途中の取り下げでも、元の添付を含めて言う', async () => {
    const out = captureStdout();
    const original = (name: string) => ({
      id: `att-${name}`,
      name,
      mediaType: 'text/plain',
      size: 1,
      sha256: 'x',
    });
    const calls = stubDaemon({
      chats: [{ events: OPEN + QUEUED, hold: true }],
      interrupt: [{ outcome: 'withdrawn' }],
    });
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) =>
      /\/conversations\/c1(\?|$)/.test(String(url))
        ? Promise.resolve(
            Response.json({
              conversationId: 'c1',
              messages: [
                {
                  id: 'm1',
                  at: '2026-08-16T10:00:00.000Z',
                  role: 'inbound',
                  text: '元の文',
                  attachments: [original('a.log'), original('b.log')],
                },
              ],
              scanned: 1,
              reachedStart: true,
              supersededCount: 0,
            }),
          )
        : base(url as string, init),
    );
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', '/conversation c1');
    await flush();
    rl.emit('line', '/edit 1');
    await vi.waitFor(() => expect(out()).toContain('元の文'));
    rl.emit('line', '直した文');
    await vi.waitFor(() => expect(chatsOf(calls)).toHaveLength(1));
    rl.emit('SIGINT');
    await vi.waitFor(() => expect(out()).toMatch(/送れなかった本文:\s*直した文/));
    expect(out()).toMatch(FILES_NOTE);
    rl.close();
    await done;
  });

  it('（陰性対照）添付が無ければ、今まで通り本文だけを戻す', async () => {
    const calls = stubDaemon({
      chats: [{ events: OPEN + QUEUED, hold: true }],
      interrupt: [{ outcome: 'withdrawn' }],
    });
    const out = captureStdout();
    const { chatCommand } = await import('./chat.js');
    const done = chatCommand();
    await flush();
    rl.emit('line', 'こんにちは');
    await flush();
    rl.emit('SIGINT');
    await flush();
    expect(chatsOf(calls)[0]?.aborted()).toBe(true);
    expect(out()).toMatch(/送れなかった本文:\s*こんにちは/);
    expect(out()).not.toContain('/attach');
    rl.close();
    await done;
  });
});

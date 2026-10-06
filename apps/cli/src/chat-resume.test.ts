import { afterEach, describe, expect, it, vi } from 'vitest';

import { runResumeCommand, runSlashCommand } from './chat.js';
import { createClient } from './client.js';
import type { Target } from './target.js';
import { captureStdout } from './test-support.js';

const target: Target = {
  baseUrl: 'http://127.0.0.1:4517',
  headers: { authorization: 'Bearer t' },
  remote: false,
  note: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const frame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const sse = (body: string | ReadableStream<Uint8Array>) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const openFrame = (id: string, inProgress: boolean) =>
  frame('open', { conversationId: id, inProgress });

interface Call {
  method: string;
  url: string;
  signal: AbortSignal | undefined;
}

/**
 * `GET /chat/{id}/stream` は会話ごとに順に積んだ応答を返す。会話の一覧と詳細と既読は固定。
 * 実時間は待たない。
 */
function stub(options: {
  conversations?: string[];
  streams: Record<string, (() => Response | Error)[]>;
  readStatus?: number;
}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    calls.push({ method, url, signal: init?.signal ?? undefined });
    const stream = /\/chat\/([^/]+)\/stream$/.exec(url);
    if (stream !== null) {
      const next = options.streams[decodeURIComponent(stream[1] ?? '')]?.shift();
      if (next === undefined) throw new Error(`想定外の接続: ${url}`);
      const made = next();
      return made instanceof Error ? Promise.reject(made) : Promise.resolve(made);
    }
    if (url.endsWith('/read')) {
      return Promise.resolve(
        options.readStatus === undefined || options.readStatus === 200
          ? Response.json({ readThrough: 't', unreadCount: 0 })
          : Response.json({ error: '既読にできない理由' }, { status: options.readStatus }),
      );
    }
    if (/\/conversations\/[^/?]+/.test(url)) {
      return Promise.resolve(
        Response.json({
          messages: [
            { id: 'm1', at: 't1', role: 'inbound', text: '質問' },
            { id: 'm2', at: 't2', role: 'outbound', text: '答え' },
          ],
          scanned: 2,
          reachedStart: true,
          supersededCount: 0,
        }),
      );
    }
    if (/\/conversations(\?|$)/.test(url)) {
      return Promise.resolve(
        Response.json({
          conversations: (options.conversations ?? []).map((conversationId) => ({
            conversationId,
            startedAt: 't',
            updatedAt: 't',
            messages: 2,
            preview: conversationId,
          })),
          scanned: 1,
          reachedStart: true,
          hiddenByLimit: 0,
        }),
      );
    }
    throw new Error(`想定外の要求: ${method} ${url}`);
  });
  return calls;
}

const streamCalls = (calls: Call[]) => calls.filter((c) => /\/stream$/.test(c.url));
const readCalls = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/read'));

describe('/resume（REPL から進行中のターンへ戻る）', () => {
  it('id 無しは新しい順に探し、最初の進行中の会話の途中経過と続きを描いて、その id を返す（探す接続は閉じる）', async () => {
    const calls = stub({
      conversations: ['c1', 'c2', 'c3'],
      streams: {
        c1: [() => sse(openFrame('c1', false))],
        c2: [
          () => sse(openFrame('c2', true)),
          () =>
            sse(
              openFrame('c2', true) +
                frame('text', { text: 'ここまで' }) +
                frame('tool', { tool: 'Read' }) +
                frame('text', { text: '続き\n' }) +
                frame('done', { type: 'done' }),
            ),
        ],
      },
    });
    const out = captureStdout();
    expect(await runResumeCommand('/resume', target)).toBe('c2');
    expect(streamCalls(calls).map((c) => c.url)).toEqual([
      'http://127.0.0.1:4517/chat/c1/stream',
      'http://127.0.0.1:4517/chat/c2/stream',
      'http://127.0.0.1:4517/chat/c2/stream',
    ]);
    expect(streamCalls(calls)[0]?.signal?.aborted).toBe(true);
    expect(streamCalls(calls)[1]?.signal?.aborted).toBe(true);
    expect(out()).toBe('ここまで\n  · Read\n続き\n\n');
  });

  it('返答を最後まで描いたら、sendMessage と同じく取り直した最後の発言まで既読にする', async () => {
    const calls = stub({
      streams: {
        c2: [
          () => sse(openFrame('c2', true)),
          () => sse(openFrame('c2', true) + frame('text', { text: '答え\n' }) + frame('done', {})),
        ],
      },
    });
    captureStdout();
    expect(await runResumeCommand('/resume c2', target)).toBe('c2');
    expect(readCalls(calls)).toHaveLength(1);
    expect(readCalls(calls)[0]?.url).toBe('http://127.0.0.1:4517/conversations/c2/read');
  });

  it('id 指定は、その会話だけを見る', async () => {
    const calls = stub({
      conversations: ['c1', 'c2'],
      streams: { c2: [() => sse(openFrame('c2', true)), () => sse(openFrame('c2', true))] },
    });
    captureStdout();
    expect(await runResumeCommand('/resume c2', target)).toBe('c2');
    expect(calls.map((c) => c.url).some((u) => /\/conversations(\?|$)/.test(u))).toBe(false);
    expect(streamCalls(calls)).toHaveLength(2);
  });

  it('進行中の会話が無ければ通知を出し、null を返す（今の会話のまま）', async () => {
    const calls = stub({
      conversations: ['c1', 'c2'],
      streams: { c1: [() => sse(openFrame('c1', false))], c2: [() => sse(openFrame('c2', false))] },
    });
    const out = captureStdout();
    expect(await runResumeCommand('/resume', target)).toBeNull();
    expect(out()).toBe('進行中の会話は無い（/conversations で履歴を見られる）\n');
    expect(streamCalls(calls)).toHaveLength(2);
  });

  it('id 指定で進行中でなければ、その id を添えて通知する（無い会話・終わった会話も同じ）', async () => {
    stub({ streams: { c1: [() => sse(openFrame('c1', false))] } });
    const out = captureStdout();
    expect(await runResumeCommand('/resume c1', target)).toBeNull();
    expect(out()).toBe('会話 c1 に進行中のターンは無い（/conversations で履歴を見られる）\n');
  });

  it('探すのは新しい順に最大 5 件まで', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const calls = stub({
      conversations: ids,
      streams: Object.fromEntries(ids.map((id) => [id, [() => sse(openFrame(id, false))]])),
    });
    captureStdout();
    await runResumeCommand('/resume', target);
    expect(streamCalls(calls).map((c) => c.url.split('/')[4])).toEqual(ids.slice(0, 5));
  });

  it('履歴が空なら接続を張らずに通知する', async () => {
    const calls = stub({ conversations: [], streams: {} });
    const out = captureStdout();
    expect(await runResumeCommand('/resume', target)).toBeNull();
    expect(streamCalls(calls)).toEqual([]);
    expect(out()).toContain('進行中の会話は無い');
  });

  it('繋がれなければ理由つきのエラーを出し、投げずに null を返す', async () => {
    stub({ streams: { c1: [() => new Error('つながらない')] } });
    const out = captureStdout();
    expect(await runResumeCommand('/resume c1', target)).toBeNull();
    expect(out()).toContain('エラー: 進行中の応答に戻れませんでした: デーモンに繋がりません');
    expect(out()).toContain('つながらない');
  });

  it('HTTP の失敗は本文の理由をそのまま出す', async () => {
    stub({
      streams: {
        c1: [() => Response.json({ error: 'この器は途中経過を持たない' }, { status: 503 })],
      },
    });
    const out = captureStdout();
    expect(await runResumeCommand('/resume c1', target)).toBeNull();
    expect(out()).toBe('エラー: 進行中の応答に戻れませんでした: この器は途中経過を持たない\n');
  });

  it('途中で切れたら、描きかけの行は書き切って知らせ、既読にはしない。会話 id は返す', async () => {
    const encoder = new TextEncoder();
    let pulled = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled === 1) {
          controller.enqueue(
            encoder.encode(openFrame('c1', true) + frame('text', { text: '途中まで' })),
          );
        } else {
          controller.error(new Error('reset'));
        }
      },
    });
    const calls = stub({ streams: { c1: [() => sse(openFrame('c1', true)), () => sse(broken)] } });
    const out = captureStdout();
    expect(await runResumeCommand('/resume c1', target)).toBe('c1');
    expect(out()).toContain('途中まで\n');
    expect(out()).toContain('進行中の応答に戻れませんでした: 接続が切れました（');
    expect(readCalls(calls)).toEqual([]);
  });

  it('例外で切れたときは、切断の文を1つだけ出し、止める理由もそれにする（正常な終端なしの文は出さない）', async () => {
    const encoder = new TextEncoder();
    let pulled = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled === 1) {
          controller.enqueue(
            encoder.encode(openFrame('c1', true) + frame('text', { text: '途中まで' })),
          );
        } else {
          controller.error(new Error('reset'));
        }
      },
    });
    stub({ streams: { c1: [() => sse(openFrame('c1', true)), () => sse(broken)] } });
    const out = captureStdout();
    const reasons: string[] = [];
    await runResumeCommand('/resume c1', target, (reason) => reasons.push(reason));
    expect(out()).not.toContain('done も error も来ないまま');
    expect(out().match(/接続が切れました/g)).toHaveLength(1);
    expect(reasons).toEqual(['進行中の応答に戻れませんでした: 接続が切れました（reset）']);
  });

  it('終端の無いまま正常に閉じたときは、従来どおり「途中で切れました」を出す', async () => {
    stub({
      streams: {
        c1: [
          () => sse(openFrame('c1', true)),
          () => sse(openFrame('c1', true) + frame('text', { text: '途中まで' })),
        ],
      },
    });
    const out = captureStdout();
    const reasons: string[] = [];
    await runResumeCommand('/resume c1', target, (reason) => reasons.push(reason));
    expect(out()).toContain('応答が途中で切れました（done も error も来ないまま');
    expect(reasons).toEqual(['応答が終端の無いまま切れた（done も error も来なかった）']);
  });

  it('error で終わったら既読にしない', async () => {
    const calls = stub({
      streams: {
        c1: [
          () => sse(openFrame('c1', true)),
          () =>
            sse(openFrame('c1', true) + frame('done', {}) + frame('error', { message: '失敗' })),
        ],
      },
    });
    const out = captureStdout();
    await runResumeCommand('/resume c1', target);
    expect(out()).toContain('エラー: 失敗');
    expect(readCalls(calls)).toEqual([]);
  });

  it('戻っても発言も中断も送らない（ターンは止めない）', async () => {
    const calls = stub({
      streams: {
        c1: [
          () => sse(openFrame('c1', true)),
          () => sse(openFrame('c1', true) + frame('done', {})),
        ],
      },
    });
    captureStdout();
    await runResumeCommand('/resume c1', target);
    expect(calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/read'))).toEqual([]);
  });

  it('/help に載る', async () => {
    const out = captureStdout();
    await runSlashCommand('/help', createClient(target.baseUrl, target.headers), {
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
    });
    expect(out()).toContain('/resume [id]');
  });
});

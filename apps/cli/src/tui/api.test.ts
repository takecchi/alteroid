import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, createTuiApi, type ChatEvent } from './api.js';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let sent: Sent[] = [];
let replies: (() => Response)[] = [];

const json =
  (body: unknown, status = 200): (() => Response) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sse =
  (text: string, status = 200): (() => Response) =>
  () =>
    new Response(text, { status, headers: { 'content-type': 'text/event-stream' } });

beforeEach(() => {
  sent = [];
  replies = [];
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    const request = input as Request;
    const isRequest = typeof input !== 'string' && !(input instanceof URL);
    const headers = new Headers(isRequest ? request.headers : init?.headers);
    sent.push({
      url: isRequest ? request.url : String(input),
      method: isRequest ? request.method : (init?.method ?? 'GET'),
      headers: Object.fromEntries(headers.entries()),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected fetch');
    return Promise.resolve(reply());
  });
});

afterEach(() => vi.unstubAllGlobals());

const target = {
  baseUrl: 'http://127.0.0.1:4517',
  headers: { authorization: 'Bearer tok' },
  remote: false,
  note: null,
};

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe('chat（POST /chat の SSE）', () => {
  it('Web・既存 CLI と同じ body（text と conversationId だけ）を認証ヘッダ付きで送る', async () => {
    replies.push(sse('event: open\ndata: {"conversationId":"c1"}\n\n'));
    const api = createTuiApi(target);
    await collect(api.chat({ text: 'やあ', conversationId: 'c0' }, new AbortController().signal));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: 'http://127.0.0.1:4517/chat', method: 'POST' });
    expect(sent[0]?.headers).toMatchObject({
      authorization: 'Bearer tok',
      'content-type': 'application/json',
    });
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ text: 'やあ', conversationId: 'c0' });
  });

  it('新しい会話では conversationId を送らない', async () => {
    replies.push(sse(''));
    await collect(createTuiApi(target).chat({ text: 'hi' }, new AbortController().signal));
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ text: 'hi' });
  });

  it('9 種のイベントを型付きで渡し、未知のイベントは無視する', async () => {
    replies.push(
      sse(
        [
          'event: open\ndata: {"conversationId":"c1"}',
          'event: queued\ndata: {"type":"queued"}',
          'event: thinking\ndata: {"type":"thinking"}',
          'event: text\ndata: {"type":"text","text":"こん"}',
          'event: tool\ndata: {"type":"tool","tool":"Bash"}',
          'event: ask_human\ndata: {"type":"ask_human","approvalId":"a1","question":"どっち？"}',
          'event: usage_limited\ndata: {"type":"usage_limited","message":"枠が閉じている"}',
          'event: error\ndata: {"type":"error","message":"失敗"}',
          'event: done\ndata: {"type":"done"}',
          'event: future_thing\ndata: {"type":"future_thing"}',
        ].join('\n\n') + '\n\n',
      ),
    );
    const events: ChatEvent[] = await collect(
      createTuiApi(target).chat({ text: 'x' }, new AbortController().signal),
    );
    expect(events.map((e) => e.type)).toEqual([
      'open',
      'queued',
      'thinking',
      'text',
      'tool',
      'ask_human',
      'usage_limited',
      'error',
      'done',
    ]);
    expect(events[0]).toEqual({ type: 'open', conversationId: 'c1' });
    expect(events[5]).toMatchObject({ approvalId: 'a1', question: 'どっち？' });
  });

  it('401 は既存 CLI と同じ認証の案内文で失敗する', async () => {
    replies.push(json({ error: 'unauthorized' }, 401));
    const api = createTuiApi(target);
    await expect(collect(api.chat({ text: 'x' }, new AbortController().signal))).rejects.toThrow(
      /認証されませんでした/,
    );
  });

  it('その他の失敗はデーモンの理由つきの ApiError', async () => {
    replies.push(json({ error: 'supersedes が不正' }, 400));
    const api = createTuiApi(target);
    const failure = collect(api.chat({ text: 'x' }, new AbortController().signal));
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    replies.push(json({ error: '理由です' }, 500));
    await expect(collect(api.chat({ text: 'x' }, new AbortController().signal))).rejects.toThrow(
      /HTTP 500.*理由です/,
    );
  });

  it('繋がらないときは接続できない旨で失敗する。自分で中断したときは黙って終わる', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
    const api = createTuiApi(target);
    await expect(collect(api.chat({ text: 'x' }, new AbortController().signal))).rejects.toThrow(
      /デーモンに繋がりません/,
    );
    const aborted = new AbortController();
    aborted.abort();
    await expect(collect(api.chat({ text: 'x' }, aborted.signal))).resolves.toEqual([]);
  });
});

describe('JSON の口（hono/client）', () => {
  it('会話の一覧・中身・終了・中断', async () => {
    const api = createTuiApi(target);
    replies.push(
      json({
        conversations: [
          { conversationId: 'c1', startedAt: 's', updatedAt: 'u', messages: 2, preview: 'p' },
        ],
        scanned: 1,
        reachedStart: true,
        hiddenByLimit: 0,
      }),
    );
    expect((await api.listConversations()).map((c) => c.conversationId)).toEqual(['c1']);
    expect(sent[0]?.url).toContain('/conversations');

    replies.push(
      json({
        conversationId: 'c1',
        messages: [{ id: 'm1', at: 't', role: 'inbound', text: 'こんにちは' }],
        scanned: 1,
        reachedStart: true,
        supersededCount: 0,
      }),
    );
    expect(await api.readConversation('c1')).toEqual({
      messages: [{ id: 'm1', at: 't', role: 'inbound', text: 'こんにちは' }],
      reachedStart: true,
    });

    replies.push(json({ error: 'no' }, 404));
    expect(await api.readConversation('zzz')).toBeNull();

    replies.push(json({ ok: true }));
    await api.endConversation('c1');
    expect(sent.at(-1)).toMatchObject({ method: 'POST' });
    expect(sent.at(-1)?.url).toContain('/chat/c1/end');

    replies.push(json({ outcome: 'idle' }));
    expect(await api.interrupt()).toBe('走っているターンは無かった（止めるものが無い）。');
    expect(sent.at(-1)?.url).toContain('/clone/interrupt');
  });

  it('403 は権限の案内、その他の失敗は例外', async () => {
    const api = createTuiApi(target);
    replies.push(json({ error: 'forbidden' }, 403));
    await expect(api.endConversation('c1')).rejects.toThrow(/許可がありません/);
    replies.push(json({ error: 'boom' }, 500));
    await expect(api.interrupt()).rejects.toThrow(/止められませんでした（HTTP 500）/);
  });

  it('ヘッダの件数は未回答の承認待ちと、running の委譲だけを数える', async () => {
    const api = createTuiApi(target);
    replies.push(json({ approvals: [{ id: 'a' }, { id: 'b' }] }));
    replies.push(
      json({
        managers: [
          { managerId: '1', status: 'running' },
          { managerId: '2', status: 'waiting_human' },
          { managerId: '3', status: 'done' },
          { managerId: '4', status: 'running' },
        ],
      }),
    );
    expect(await api.headerCounts()).toEqual({ pendingApprovals: 2, runningManagers: 2 });
    const urls = sent.map((s) => s.url);
    expect(urls.some((u) => u.includes('/approvals'))).toBe(true);
    expect(urls.some((u) => u.includes('/managers'))).toBe(true);
  });
});

describe('journalStream（GET /journal/stream）', () => {
  it('open と、届いたエントリの種別を順に流す。認証ヘッダを付ける', async () => {
    replies.push(
      sse(
        'event: open\ndata: {"ok":true}\n\nevent: escalation\ndata: {"type":"escalation"}\n\n: ping\n\n',
      ),
    );
    const api = createTuiApi(target);
    const names = await collect(api.journalStream(new AbortController().signal));
    expect(names).toEqual(['open', 'escalation']);
    expect(sent[0]).toMatchObject({ url: 'http://127.0.0.1:4517/journal/stream', method: 'GET' });
    expect(sent[0]?.headers.authorization).toBe('Bearer tok');
  });

  it('リモートで未認証なら ログインの案内で失敗する', async () => {
    replies.push(json({ error: 'x' }, 401));
    const api = createTuiApi({ ...target, remote: true, baseUrl: 'https://alt.example.com' });
    await expect(collect(api.journalStream(new AbortController().signal))).rejects.toThrow(
      /alteroid login/,
    );
  });
});

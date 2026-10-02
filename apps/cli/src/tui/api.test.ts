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
  it('open と、届いたエントリ（種別と本体）を順に流す。認証ヘッダを付ける', async () => {
    replies.push(
      sse(
        'event: open\ndata: {"ok":true}\n\nevent: escalation\ndata: {"type":"escalation"}\n\n: ping\n\n',
      ),
    );
    const api = createTuiApi(target);
    const items = await collect(api.journalStream(new AbortController().signal));
    // 種別と本体（日誌のタブが、この 1 本から本体を受ける）。open は本体なし。
    expect(items).toEqual([
      { type: 'open', entry: null },
      { type: 'escalation', entry: { type: 'escalation' } },
    ]);
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

describe('日誌と記憶の口', () => {
  it('GET /journal: limit・type（カンマ区切り）・q・since・until・horizon を Web と同じ名前で送る', async () => {
    const api = createTuiApi(target);
    replies.push(
      json({
        entries: [{ id: 'e1', at: 't', type: 'exchange' }],
        oldestAt: 'o',
        crossesHorizon: true,
      }),
    );
    const result = await api.listJournal({
      limit: 100,
      types: ['decision', 'escalation'],
      q: '語',
      until: '2026-10-02T00:00:00.000Z',
      horizon: true,
    });
    expect(result).toEqual({
      entries: [{ id: 'e1', at: 't', type: 'exchange' }],
      oldestAt: 'o',
      crossesHorizon: true,
    });
    const url = new URL(sent[0]?.url ?? '');
    expect(url.pathname).toBe('/journal');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '100',
      type: 'decision,escalation',
      q: '語',
      until: '2026-10-02T00:00:00.000Z',
      horizon: 'true',
    });
    expect(sent[0]?.method).toBe('GET');
  });

  it('GET /journal: 絞らないときは type も q も送らない。失敗は理由つきの例外', async () => {
    const api = createTuiApi(target);
    replies.push(json({ entries: [] }));
    await api.listJournal({ limit: 20, types: [], q: '' });
    expect(Object.fromEntries(new URL(sent[0]?.url ?? '').searchParams)).toEqual({ limit: '20' });
    replies.push(json({ error: 'type が不正' }, 400));
    await expect(api.listJournal({ limit: 20 })).rejects.toThrow(
      /日誌を読めませんでした（HTTP 400）/,
    );
  });

  it('GET /memory は documents、GET /memory/{slug} は document。404 は null', async () => {
    const api = createTuiApi(target);
    replies.push(json({ documents: [{ slug: 'a', title: 'A' }] }));
    expect((await api.listMemory()).map((r) => r.slug)).toEqual(['a']);
    expect(new URL(sent[0]?.url ?? '').pathname).toBe('/memory');

    replies.push(json({ document: { slug: 'a', content: '# A', updatedAt: 'u' } }));
    expect((await api.readMemory('a'))?.content).toBe('# A');
    expect(new URL(sent[1]?.url ?? '').pathname).toBe('/memory/a');
    expect(sent[1]?.method).toBe('GET');

    replies.push(json({ error: 'no' }, 404));
    expect(await api.readMemory('zzz')).toBeNull();
    replies.push(json({ error: 'boom' }, 500));
    await expect(api.readMemory('a')).rejects.toThrow(/記憶を読めませんでした（HTTP 500）/);
  });
});

const searchOf = (index: number): Record<string, string> =>
  Object.fromEntries(new URL(sent[index]?.url ?? '').searchParams);

describe('委譲の口（#2591。本物の createTuiApi を通す）', () => {
  it('GET /managers: status（カンマ区切り）・limit・afterId・afterStartedAt を送る', async () => {
    const api = createTuiApi(target);
    replies.push(
      json({
        managers: [{ managerId: 'm1', status: 'running' }],
        unreadable: [{ managerId: 'bad', reason: '壊れている' }],
      }),
    );
    const result = await api.listManagers({
      status: ['running', 'waiting_human'],
      limit: 50,
      after: { managerId: 'm0', startedAt: '2026-10-01T00:00:00.000Z' },
    });
    expect(new URL(sent[0]?.url ?? '').pathname).toBe('/managers');
    expect(sent[0]?.method).toBe('GET');
    expect(searchOf(0)).toEqual({
      status: 'running,waiting_human',
      limit: '50',
      afterId: 'm0',
      afterStartedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(result.managers.map((m) => m.managerId)).toEqual(['m1']);
    expect(result.unreadable).toEqual([{ managerId: 'bad', reason: '壊れている' }]);
  });

  it('GET /managers: 絞らないときは何も送らない。unreadable が無ければ空配列', async () => {
    const api = createTuiApi(target);
    replies.push(json({ managers: [] }));
    const result = await api.listManagers({});
    expect(searchOf(0)).toEqual({});
    expect(result).toEqual({ managers: [], unreadable: [] });
  });

  it('GET /managers/{id}: 404 は null、409 は理由つきの ApiError、成功は manager', async () => {
    const api = createTuiApi(target);
    replies.push(json({ manager: { managerId: 'm1', status: 'done' } }));
    expect((await api.readManager('m1'))?.managerId).toBe('m1');
    expect(new URL(sent[0]?.url ?? '').pathname).toBe('/managers/m1');

    replies.push(json({ error: 'no' }, 404));
    expect(await api.readManager('zzz')).toBeNull();

    replies.push(json({ error: '行が読めない形' }, 409));
    const failure = api.readManager('bad');
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    replies.push(json({ error: '行が読めない形' }, 409));
    await expect(api.readManager('bad')).rejects.toThrow(
      /委譲を読めませんでした（HTTP 409）: 行が読めない形/,
    );
  });

  it('GET /managers/{id}/transcript: 404 は null、成功は生テキストのまま', async () => {
    const api = createTuiApi(target);
    replies.push(() => new Response('{"a":1}\n{"b":2}\n', { status: 200 }));
    expect(await api.readManagerTranscript('m1')).toBe('{"a":1}\n{"b":2}\n');
    expect(new URL(sent[0]?.url ?? '').pathname).toBe('/managers/m1/transcript');

    replies.push(json({ error: 'まだ無い' }, 404));
    expect(await api.readManagerTranscript('m1')).toBeNull();

    replies.push(json({ error: 'boom' }, 500));
    await expect(api.readManagerTranscript('m1')).rejects.toThrow(
      /委譲の生ログを読めませんでした（HTTP 500）: boom/,
    );
  });

  it('POST /managers/{id}/messages: text だけを送る（requestId / decision は付けない）', async () => {
    const api = createTuiApi(target);
    replies.push(json({ outcome: 'delivered', detail: '渡した' }));
    expect(await api.sendManagerMessage('m1', '続けて')).toEqual({
      outcome: 'delivered',
      detail: '渡した',
    });
    expect(sent[0]).toMatchObject({ method: 'POST' });
    expect(new URL(sent[0]?.url ?? '').pathname).toBe('/managers/m1/messages');
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ text: '続けて' });

    replies.push(json({ error: 'no' }, 404));
    await expect(api.sendManagerMessage('zzz', 'x')).rejects.toThrow(
      /そのマネージャーは見つかりませんでした: zzz/,
    );
    replies.push(json({ error: '空は送れない' }, 400));
    await expect(api.sendManagerMessage('m1', '')).rejects.toThrow(
      /送れませんでした（HTTP 400）: 空は送れない/,
    );
  });

  it('DELETE /managers/{id}: 結果を返し、404 は見つからない旨、その他は理由つき', async () => {
    const api = createTuiApi(target);
    replies.push(json({ outcome: 'stopped', detail: '止めた' }));
    expect(await api.stopManager('m1')).toEqual({ outcome: 'stopped', detail: '止めた' });
    expect(sent[0]).toMatchObject({ method: 'DELETE' });
    expect(new URL(sent[0]?.url ?? '').pathname).toBe('/managers/m1');

    replies.push(json({ error: 'no' }, 404));
    await expect(api.stopManager('zzz')).rejects.toThrow(
      /そのマネージャーは見つかりませんでした: zzz/,
    );
    replies.push(json({ error: 'もう終わっている' }, 409));
    await expect(api.stopManager('m1')).rejects.toThrow(
      /止められませんでした（HTTP 409）: もう終わっている/,
    );
  });
});

describe('承認待ちの口（#2591。本物の createTuiApi を通す）', () => {
  it('GET /approvals: 未回答だけなら order=asc のみ、全件なら pending=false も送る', async () => {
    const api = createTuiApi(target);
    replies.push(
      json({
        approvals: [{ id: 'a1', createdAt: 't', question: 'q' }],
        unreadable: [{ id: 'x', reason: '壊れている' }],
      }),
    );
    const pending = await api.listApprovals({ pending: true });
    expect(new URL(sent[0]?.url ?? '').pathname).toBe('/approvals');
    expect(searchOf(0)).toEqual({ order: 'asc' });
    expect(pending.approvals.map((a) => a.id)).toEqual(['a1']);
    expect(pending.unreadable).toEqual([{ id: 'x', reason: '壊れている' }]);

    replies.push(json({ approvals: [] }));
    const all = await api.listApprovals({ pending: false });
    expect(searchOf(1)).toEqual({ order: 'asc', pending: 'false' });
    expect(all).toEqual({ approvals: [], unreadable: [] });
  });

  it('POST /approvals/{id}/answer: 自由文・選択どちらも本文をそのまま送る', async () => {
    const api = createTuiApi(target);
    replies.push(json({ ok: true }));
    await api.answerApproval('a1', { answer: 'いいよ' });
    expect(sent[0]).toMatchObject({ method: 'POST' });
    expect(new URL(sent[0]?.url ?? '').pathname).toBe('/approvals/a1/answer');
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ answer: 'いいよ' });

    replies.push(json({ ok: true }));
    await api.answerApproval('a2', {
      selections: [{ questionId: 'target', optionIds: ['fly'], other: '来週' }],
      answer: '補足',
    });
    expect(JSON.parse(sent[1]?.body ?? '')).toEqual({
      selections: [{ questionId: 'target', optionIds: ['fly'], other: '来週' }],
      answer: '補足',
    });
  });

  it('POST /approvals/{id}/answer: 400 / 409 のデーモンの理由が ApiError に載る', async () => {
    const api = createTuiApi(target);
    replies.push(json({ error: 'target は単一選択です' }, 400));
    const bad = api.answerApproval('a1', { selections: [] });
    await expect(bad).rejects.toBeInstanceOf(ApiError);
    replies.push(json({ error: 'target は単一選択です' }, 400));
    await expect(api.answerApproval('a1', { selections: [] })).rejects.toThrow(
      /回答に失敗しました（HTTP 400）: target は単一選択です/,
    );
    replies.push(json({ error: 'もう回答済みです' }, 409));
    await expect(api.answerApproval('a1', { answer: 'x' })).rejects.toThrow(
      /回答に失敗しました（HTTP 409）: もう回答済みです/,
    );
  });
});

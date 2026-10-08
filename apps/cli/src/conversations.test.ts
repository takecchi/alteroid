import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfirmIo } from './confirm.js';
import { captureStdout } from './test-support.js';

vi.mock('./target.js', () => ({
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null }),
  describeAuthFailure: () => null,
}));

const {
  conversationsDeleteCommand,
  conversationsListCommand,
  conversationsReadCommand,
  conversationsShowCommand,
} = await import('./conversations.js');

interface Sent {
  url: string;
  method: string;
}

let sent: Sent[] = [];
let originalFetch: typeof fetch;
let replies: { status: number; body: unknown }[] = [];

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    sent.push({ url, method: init?.method ?? request.method ?? 'GET' });
    const reply = replies.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent = [];
  replies = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('reject するはずが resolve した');
}

describe('alteroid conversations list', () => {
  it('GET /conversations を打ち、scanned を必ず出す（黙って打ち切らない）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        conversations: [
          {
            conversationId: 'conv-1',
            startedAt: '2026-08-16T10:00:00.000Z',
            updatedAt: '2026-08-16T10:05:00.000Z',
            messages: 3,
            preview: '設計の相談',
          },
        ],
        scanned: 512,
        reachedStart: true,
        hiddenByLimit: 0,
      },
    });

    await conversationsListCommand();

    expect(sent).toHaveLength(2);
    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/conversations');
    const text = read();
    expect(text).toContain('conv-1');
    expect(text).toContain('設計の相談');
    expect(text).toContain('512');
    expect(text).toContain('conversations show');
    expect(text).not.toContain('先頭には届いていない');
    expect(text).not.toContain('…ほか');
  });

  it('reachedStart が偽なら、先頭に届いていないと言う', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        conversations: [
          {
            conversationId: 'conv-1',
            startedAt: '2026-08-16T10:00:00.000Z',
            updatedAt: '2026-08-16T10:05:00.000Z',
            messages: 3,
            preview: '設計の相談',
          },
        ],
        scanned: 2000,
        reachedStart: false,
        hiddenByLimit: 0,
      },
    });

    await conversationsListCommand();

    const text = read();
    expect(text).toContain('先頭には届いていない');
    expect(text).not.toContain('…ほか');
  });

  it('hiddenByLimit が正なら、省いた件数を言う', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        conversations: [
          {
            conversationId: 'conv-1',
            startedAt: '2026-08-16T10:00:00.000Z',
            updatedAt: '2026-08-16T10:05:00.000Z',
            messages: 3,
            preview: '設計の相談',
          },
        ],
        scanned: 512,
        reachedStart: true,
        hiddenByLimit: 4,
      },
    });

    await conversationsListCommand();

    const text = read();
    expect(text).toContain('…ほか 4 件は省略');
    expect(text).toContain('--limit を増やせば');
    expect(text).not.toContain('先頭には届いていない');
  });

  it('作成（startedAt）を出す', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        conversations: [
          {
            conversationId: 'conv-1',
            startedAt: '2026-08-16T10:00:00.000Z',
            updatedAt: '2026-08-16T10:05:00.000Z',
            messages: 3,
            preview: '設計の相談',
          },
        ],
        scanned: 512,
        reachedStart: true,
        hiddenByLimit: 0,
      },
    });

    await conversationsListCommand();

    const text = read();
    expect(text).toContain('作成: 2026-08-16T10:00:00.000Z');
    expect(text).toContain('更新: 2026-08-16T10:05:00.000Z');
  });

  it('作成・更新それぞれの横に経過を添える。ISO は消えない', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        conversations: [
          {
            conversationId: 'conv-1',
            startedAt: '2026-08-16T10:00:00.000Z',
            updatedAt: '2026-08-17T10:00:00.000Z',
            messages: 3,
            preview: '設計の相談',
          },
        ],
        scanned: 512,
        reachedStart: true,
        hiddenByLimit: 0,
      },
    });

    await conversationsListCommand({}, new Date('2026-08-18T10:00:00.000Z').getTime());

    const text = read();
    expect(text).toContain('作成: 2026-08-16T10:00:00.000Z（2日前）');
    expect(text).toContain('更新: 2026-08-17T10:00:00.000Z（1日前）');
  });

  it('--limit / --scan をクエリへそのまま渡す', async () => {
    captureStdout();
    replies.push({
      status: 200,
      body: { conversations: [], scanned: 0, reachedStart: true, hiddenByLimit: 0 },
    });

    await conversationsListCommand({ limit: '5', scan: '9000' });

    expect(sent).toHaveLength(2);
    const url = new URL(sent[0]?.url ?? '');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('scan')).toBe('9000');
  });

  it('nextCursor が在れば続きの読み方を出し、--cursor はクエリへそのまま渡す（#3550）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        conversations: [],
        scanned: 2000,
        reachedStart: false,
        hiddenByLimit: 0,
        nextCursor: 'abc_DEF-123',
      },
    });

    await conversationsListCommand({ cursor: 'prev-cursor' });

    expect(new URL(sent[0]?.url ?? '').searchParams.get('cursor')).toBe('prev-cursor');
    expect(read()).toContain('続きを読むには: alteroid conversations list --cursor abc_DEF-123');
  });

  it('nextCursor が無ければ続きの案内を出さない（#3550）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { conversations: [], scanned: 3, reachedStart: true, hiddenByLimit: 0 },
    });

    await conversationsListCommand();

    expect(read()).not.toContain('--cursor');
  });

  it('空でも、そう言う（黙って何も出さない形にしない）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { conversations: [], scanned: 0, reachedStart: true, hiddenByLimit: 0 },
    });

    await conversationsListCommand();

    expect(read()).toContain('会話はまだありません');
  });

  it('クエリが不正（400）なら、読めなかったと言う', async () => {
    replies.push({ status: 400, body: { error: 'invalid' } });

    await expect(conversationsListCommand({ limit: '0' })).rejects.toThrow('読めませんでした');
  });

  it('出力は改行で終わる（#326）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        conversations: [
          {
            conversationId: 'conv-1',
            startedAt: '2026-08-16T10:00:00.000Z',
            updatedAt: '2026-08-16T10:05:00.000Z',
            messages: 3,
            preview: '設計の相談',
          },
        ],
        scanned: 512,
        reachedStart: true,
        hiddenByLimit: 0,
      },
    });

    await conversationsListCommand();

    expect(read().endsWith('\n')).toBe(true);
  });

  it('空の一覧でも出力は改行で終わる（#326）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { conversations: [], scanned: 0, reachedStart: true, hiddenByLimit: 0 },
    });

    await conversationsListCommand();

    expect(read().endsWith('\n')).toBe(true);
  });
});

describe('alteroid conversations list の未読', () => {
  const row = (conversationId: string, unreadCount: number) => ({
    conversationId,
    startedAt: '2026-08-16T10:00:00.000Z',
    updatedAt: '2026-08-16T10:05:00.000Z',
    messages: 3,
    preview: '相談',
    unreadCount,
  });

  it('未読がある会話の行にだけ「未読 N」を出す', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        conversations: [row('conv-unread', 2), row('conv-read', 0)],
        scanned: 5,
        reachedStart: true,
        hiddenByLimit: 0,
      },
    });
    await conversationsListCommand();
    const lines = read().split('\n');
    expect(lines.find((l) => l.includes('conv-unread'))).toContain('未読 2');
    expect(lines.find((l) => l.includes('conv-read'))).not.toContain('未読');
  });
});

describe('alteroid conversations list の未読の総数', () => {
  const emptyList = {
    status: 200,
    body: { conversations: [], scanned: 0, reachedStart: true, hiddenByLimit: 0 },
  };

  it('GET /conversations/unread-count の数を「未読のある会話 N 件」で出す（一覧の外の分も含む総数）', async () => {
    const read = captureStdout();
    replies.push(emptyList, { status: 200, body: { count: 7, capped: false } });
    await conversationsListCommand();
    expect(sent.map((s) => s.url)).toEqual([
      'http://127.0.0.1:4517/conversations',
      'http://127.0.0.1:4517/conversations/unread-count',
    ]);
    expect(read()).toContain('未読のある会話 7 件');
    expect(read()).not.toContain('取れませんでした');
  });

  it('0件でも 0 と言う（取れなかった場合と区別できる）', async () => {
    const read = captureStdout();
    replies.push(emptyList, { status: 200, body: { count: 0, capped: false } });
    await conversationsListCommand();
    expect(read()).toContain('未読のある会話 0 件');
  });

  it('capped のときは下限として「N 件以上」と言う（Web の「N+」と同じ意味）', async () => {
    const read = captureStdout();
    replies.push(emptyList, { status: 200, body: { count: 99, capped: true } });
    await conversationsListCommand();
    expect(read()).toContain('未読のある会話 99 件以上');
  });

  it('総数が 500 でも一覧は出し、取れなかったと1行で言う（例外にしない）', async () => {
    const read = captureStdout();
    replies.push(
      {
        status: 200,
        body: {
          conversations: [
            {
              conversationId: 'conv-1',
              startedAt: '2026-08-16T10:00:00.000Z',
              updatedAt: '2026-08-16T10:05:00.000Z',
              messages: 3,
              preview: '設計の相談',
            },
          ],
          scanned: 5,
          reachedStart: true,
          hiddenByLimit: 0,
        },
      },
      { status: 500, body: { error: 'boom' } },
    );
    await conversationsListCommand();
    const text = read();
    expect(text).toContain('conv-1');
    expect(text).toContain('未読のある会話の総数は取れませんでした（HTTP 500）');
    expect(text).not.toMatch(/未読のある会話 \d+ 件/);
  });

  it('古いデーモン（404）でも一覧は出し、口が無いと1行で言う', async () => {
    const read = captureStdout();
    replies.push(emptyList, { status: 404, body: { error: 'not found' } });
    await conversationsListCommand();
    const text = read();
    expect(text).toContain('会話はまだありません');
    expect(text).toContain('未読のある会話の総数は取れませんでした');
    expect(text).toContain('古い版');
  });

  it('通信が途切れて総数だけ失敗しても、一覧は出す', async () => {
    const read = captureStdout();
    replies.push(emptyList);
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return calls === 1 ? realFetch(...args) : Promise.reject(new Error('socket hang up'));
    }) as typeof fetch;
    await conversationsListCommand();
    const text = read();
    expect(text).toContain('会話はまだありません');
    expect(text).toContain('取れませんでした（socket hang up）');
  });

  it('既読の記録が読めない・形が違う応答は、0 件と言わず読めていないと言う', async () => {
    const read = captureStdout();
    replies.push(emptyList, {
      status: 200,
      body: { count: 0, capped: false, readStateUnreadable: '読めない' },
    });
    await conversationsListCommand();
    expect(read()).toContain('取れませんでした');
    expect(read()).not.toContain('未読のある会話 0 件');
  });
});

describe('alteroid conversations read', () => {
  const detail = {
    conversationId: 'conv-1',
    messages: [
      { id: 'm1', at: '2026-08-16T10:00:00.000Z', role: 'inbound', text: '質問' },
      { id: 'm2', at: '2026-08-16T10:01:00.000Z', role: 'outbound', text: '返答' },
    ],
    scanned: 2,
    reachedStart: true,
    supersededCount: 0,
    readThrough: null,
    unreadCount: 1,
  };

  it('最新の発言の id を指して既読にする', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: detail });
    replies.push({
      status: 200,
      body: { conversationId: 'conv-1', readThrough: '2026-08-16T10:01:00.000Z', unreadCount: 0 },
    });
    await conversationsReadCommand('conv-1');
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET http://127.0.0.1:4517/conversations/conv-1',
      'POST http://127.0.0.1:4517/conversations/conv-1/read',
    ]);
    expect(read()).toBe('既読にしました: conv-1\n');
  });

  it('無い会話は、そう言って既読の呼びを打たない（終了コードは非 0。#2856）', async () => {
    replies.push({ status: 404, body: { error: 'not found' } });
    await expect(conversationsReadCommand('nope')).rejects.toThrow('そんな会話はありません');
    expect(sent).toHaveLength(1);
  });

  it('見える範囲に発言が無いのに未読が残るときは、既読にできなかったとして非 0 で終える（#3447）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { ...detail, messages: [], reachedStart: false, unreadCount: 3 },
    });
    await expect(conversationsReadCommand('conv-1')).rejects.toThrow(
      '既読にする発言が見つかりませんでした',
    );
    expect(sent).toHaveLength(1);
    expect(read()).toBe('');
  });

  it('未読が数えられないときも、既読にできたとは言わずに非 0 で終える（#3447）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { ...detail, messages: [], reachedStart: false, unreadCount: null },
    });
    await expect(conversationsReadCommand('conv-1')).rejects.toThrow(
      '既読にする発言が見つかりませんでした',
    );
    expect(sent).toHaveLength(1);
    expect(read()).toBe('');
  });

  it('発言が無く未読も無いときは、既読の呼びを打たずに未読が無いと言って 0 で終える（#3447）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { ...detail, messages: [], reachedStart: true, unreadCount: 0 },
    });
    await conversationsReadCommand('conv-1');
    expect(sent).toHaveLength(1);
    expect(read()).toBe('未読の発言はありません: conv-1\n');
  });
});

describe('alteroid conversations show', () => {
  it('GET /conversations/<id> を打ち、発言を古い順に出す', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        conversationId: 'conv-1',
        messages: [
          { id: 'm1', at: '2026-08-16T10:00:00.000Z', role: 'inbound', text: '設計どうする？' },
          { id: 'm2', at: '2026-08-16T10:01:00.000Z', role: 'outbound', text: 'こう考えている' },
        ],
        scanned: 88,
        reachedStart: true,
      },
    });

    await conversationsShowCommand('conv-1');

    expect(sent).toHaveLength(2);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/conversations/conv-1');
    const text = read();
    const human = text.indexOf('設計どうする？');
    const clone = text.indexOf('こう考えている');
    expect(human).toBeGreaterThanOrEqual(0);
    expect(human).toBeLessThan(clone);
    expect(text).toContain('88');
    expect(text).toContain('先頭まで届いた');
  });

  it('--scan をクエリへそのまま渡す', async () => {
    captureStdout();
    replies.push({
      status: 200,
      body: { conversationId: 'conv-1', messages: [], scanned: 0, reachedStart: true },
    });

    await conversationsShowCommand('conv-1', { scan: '9000' });

    const url = new URL(sent[0]?.url ?? '');
    expect(url.searchParams.get('scan')).toBe('9000');
  });

  it('チャットの編集で畳まれた版があれば、--include-superseded を付けなくても件数を言う', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        conversationId: 'conv-1',
        messages: [{ id: 'm2', at: '2026-08-16T10:02:00.000Z', role: 'inbound', text: '直した文' }],
        scanned: 5,
        reachedStart: true,
        supersededCount: 2,
      },
    });

    await conversationsShowCommand('conv-1');

    const url = new URL(sent[0]?.url ?? '');
    expect(url.searchParams.get('includeSuperseded')).toBeNull();
    expect(read()).toContain('畳まれた版が 2 件ある');
  });

  it('畳まれた版が0件なら、その注記は出ない', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        conversationId: 'conv-1',
        messages: [
          { id: 'm1', at: '2026-08-16T10:00:00.000Z', role: 'inbound', text: '設計どうする？' },
        ],
        scanned: 5,
        reachedStart: true,
        supersededCount: 0,
      },
    });

    await conversationsShowCommand('conv-1');

    expect(read()).not.toContain('畳まれた版が');
  });

  it('--include-superseded を付けると畳まれた発言も出し、置き換え関係と id が読める', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        conversationId: 'conv-1',
        messages: [
          {
            id: 'm1',
            at: '2026-08-16T10:00:00.000Z',
            role: 'inbound',
            text: '元の文',
            supersededBy: 'm3',
          },
          {
            id: 'm2',
            at: '2026-08-16T10:01:00.000Z',
            role: 'outbound',
            text: '元の応答',
            supersededBy: 'm3',
          },
          {
            id: 'm3',
            at: '2026-08-16T10:02:00.000Z',
            role: 'inbound',
            text: '直した文',
            supersedes: 'm1',
          },
        ],
        scanned: 5,
        reachedStart: true,
        supersededCount: 2,
      },
    });

    await conversationsShowCommand('conv-1', { includeSuperseded: true });

    const url = new URL(sent[0]?.url ?? '');
    expect(url.searchParams.get('includeSuperseded')).toBe('true');
    const text = read();
    expect(text).toContain('id: m1');
    expect(text).toContain('id: m3');
    expect(text).toContain('元の文');
    expect(text).toContain('畳まれた版 — m3 に置き換えられた');
    expect(text).toContain('編集後の発言 — m1 を置き換えた');
  });

  it('reachedStart が偽なら「無い」と言わず、判定できないと言う', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { conversationId: 'conv-1', messages: [], scanned: 2000, reachedStart: false },
    });

    await conversationsShowCommand('conv-1');

    const text = read();
    expect(text).toContain('判定できない');
    expect(text).not.toContain('発言はありません');
    expect(text).toContain('先頭には届いていない');
  });

  it('404（遡り切れたうえで無い）なら、そう言う', async () => {
    replies.push({ status: 404, body: { error: 'not found' } });

    await expect(conversationsShowCommand('conv-missing')).rejects.toThrow(
      'そんな会話はありません: conv-missing',
    );
  });

  it('出力は改行で終わる（#326）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        conversationId: 'conv-1',
        messages: [
          { id: 'm1', at: '2026-08-16T10:00:00.000Z', role: 'inbound', text: '設計どうする？' },
        ],
        scanned: 88,
        reachedStart: true,
      },
    });

    await conversationsShowCommand('conv-1');

    expect(read().endsWith('\n')).toBe(true);
  });

  it('発言が無い会話でも出力は改行で終わる（#326）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { conversationId: 'conv-1', messages: [], scanned: 2000, reachedStart: false },
    });

    await conversationsShowCommand('conv-1');

    expect(read().endsWith('\n')).toBe(true);
  });
});

describe('alteroid conversations show — その会話のターンから積まれた承認（#3261）', () => {
  const detail = {
    conversationId: 'conv-1',
    messages: [
      { id: 'm1', at: '2026-10-06T10:00:00.000Z', role: 'inbound', text: 'どうする？' },
      { id: 'm2', at: '2026-10-06T10:04:00.000Z', role: 'outbound', text: 'A案で進めます' },
    ],
    scanned: 10,
    reachedStart: true,
  };
  const approval = {
    id: 'abcdef12-3456',
    createdAt: '2026-10-06T10:01:00.000Z',
    question: 'A案とB案のどちらにしますか？',
    answeredAt: '2026-10-06T10:03:00.000Z',
    answer: 'A案',
  };

  it('承認を、条件つきの口で取り、発言と承認と返答を時刻順に1行で出す', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: detail });
    replies.push({ status: 200, body: { approvals: [approval] } });

    await conversationsShowCommand('conv-1');

    const url = new URL(sent[1]?.url ?? '');
    expect(url.pathname).toBe('/approvals');
    expect(url.searchParams.get('conversationId')).toBe('conv-1');
    expect(url.searchParams.get('pending')).toBe('false');
    expect(url.searchParams.get('order')).toBe('asc');
    const text = read();
    const line =
      '? [2026-10-06T10:01:00.000Z] 確認（承認待ち abcdef12）: A案とB案のどちらにしますか？ ' +
      '→ 回答済み（2026-10-06T10:03:00.000Z）: A案';
    expect(text).toContain(line);
    expect(text.indexOf('どうする？')).toBeLessThan(text.indexOf(line));
    expect(text.indexOf(line)).toBeLessThan(text.indexOf('A案で進めます'));
  });

  it('未回答・取り下げも1行で出す', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: detail });
    replies.push({
      status: 200,
      body: {
        approvals: [
          { id: 'open-0001', createdAt: '2026-10-06T10:01:00.000Z', question: 'まだ' },
          {
            id: 'gone-0001',
            createdAt: '2026-10-06T10:02:00.000Z',
            question: 'やめた',
            withdrawnAt: '2026-10-06T10:02:30.000Z',
            withdrawnReason: '不要になった',
          },
        ],
      },
    });

    await conversationsShowCommand('conv-1');

    const text = read();
    expect(text).toContain('確認（承認待ち open-000）: まだ → 未回答');
    expect(text).toContain('→ 取り下げ（2026-10-06T10:02:30.000Z）: 不要になった');
  });

  it('承認を取れなくても会話は出し、取れなかったことを1行で言う', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: detail });
    replies.push({ status: 500, body: { error: '承認が読めない' } });

    await conversationsShowCommand('conv-1');

    const text = read();
    expect(text).toContain('A案で進めます');
    expect(text).toContain('この会話の承認待ちは取れませんでした');
    expect(text).toContain('承認が読めない');
  });

  it('読めない承認待ちがあれば、それも言う', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: detail });
    replies.push({
      status: 200,
      body: { approvals: [], unreadable: [{ id: 'bad-1', reason: 'x' }] },
    });

    await conversationsShowCommand('conv-1');

    expect(read()).toContain('読めない承認待ちが 1 件');
  });
});

describe('alteroid conversations の失敗の理由', () => {
  it('list: 500 + { error } なら、状態コードと理由を出す', async () => {
    replies.push({ status: 500, body: { error: '一覧が読めない（conversations のテスト用）' } });

    const error = await failureOf(conversationsListCommand());
    const text = error.message;
    expect(text).toContain('会話の一覧を読めませんでした');
    expect(text).toContain('HTTP 500');
    expect(text).toContain('一覧が読めない（conversations のテスト用）');
  });

  it('show: 500 + { error } なら、状態コードと理由を出す', async () => {
    replies.push({ status: 500, body: { error: '会話が読めない（conversations のテスト用）' } });

    const error = await failureOf(conversationsShowCommand('conv-1'));
    const text = error.message;
    expect(text).toContain('会話を読めませんでした');
    expect(text).toContain('HTTP 500');
    expect(text).toContain('会話が読めない（conversations のテスト用）');
  });

  it('show: 本文が読めない 500 でも、状態コードは出す', async () => {
    replies.push({ status: 500, body: null });

    await expect(conversationsShowCommand('conv-1')).rejects.toThrow('HTTP 500');
  });
});

describe('alteroid conversations delete（#4218）', () => {
  const DELETED = {
    conversationId: 'conv-1',
    tombstoneId: 'tomb-1',
    deletedAt: '2026-10-08T00:00:00.000Z',
    hiddenCount: 12,
    attachmentsRemoved: 2,
    commitmentsRemoved: 1,
    queuedDropped: 3,
    approvalsLinked: 4,
    incomplete: [],
    remainsIn: ['クローンの SDK セッションの生ログ', '蒸留済みの記憶・日報'],
  };

  function fakeIo(over: { isTTY?: boolean; answer?: string } = {}): {
    io: ConfirmIo;
    asked: string[];
    written: string[];
  } {
    const asked: string[] = [];
    const written: string[] = [];
    const io: ConfirmIo = {
      isTTY: over.isTTY ?? true,
      write: (text) => {
        written.push(text);
      },
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(over.answer ?? '');
      },
    };
    return { io, asked, written };
  }

  const deletes = () => sent.filter((entry) => entry.method === 'DELETE');

  it('確認で y なら DELETE /conversations/<id> を打ち、件数と remainsIn を全部出す', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: DELETED });
    const { io, asked } = fakeIo({ answer: 'y' });

    await conversationsDeleteCommand('conv-1', {}, io);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('どの画面・クローンからも読めなくなる。元に戻せない。消す? [y/N]');
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]?.url).toBe('http://127.0.0.1:4517/conversations/conv-1');
    const text = read();
    expect(text).toContain('12 件');
    expect(text).toContain('添付: 2 件');
    expect(text).toContain('台帳の約束: 1 件');
    expect(text).toContain('  - クローンの SDK セッションの生ログ');
    expect(text).toContain('  - 蒸留済みの記憶・日報');
    expect(text).not.toContain('警告');
  });

  it('確認で N（空の答えも）なら DELETE を打たない', async () => {
    for (const answer of ['N', '', 'no']) {
      sent = [];
      const { io, written } = fakeIo({ answer });

      await conversationsDeleteCommand('conv-1', {}, io);

      expect(deletes()).toHaveLength(0);
      expect(written.join('')).toContain('何も変更していません');
    }
  });

  it('--yes なら確認せずに DELETE を打つ', async () => {
    captureStdout();
    replies.push({ status: 200, body: DELETED });
    const { io, asked } = fakeIo({ answer: 'N' });

    await conversationsDeleteCommand('conv-1', { yes: true }, io);

    expect(asked).toHaveLength(0);
    expect(deletes()).toHaveLength(1);
  });

  it('端末でなく --yes も無ければ、DELETE を打たず --yes を付けてと言って落ちる', async () => {
    const { io, asked } = fakeIo({ isTTY: false, answer: 'y' });

    const error = await failureOf(conversationsDeleteCommand('conv-1', {}, io));

    expect(error.message).toContain('--yes を付けてください');
    expect(error.message).toContain('何も変更していません');
    expect(asked).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
  });

  it('incomplete が空でなければ警告として出す', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { ...DELETED, incomplete: ['受信箱の未処理の発言を外せなかった'] },
    });

    await conversationsDeleteCommand('conv-1', { yes: true });

    const text = read();
    expect(text).toContain('警告: 会話は読めなくなっていますが');
    expect(text).toContain('  - 受信箱の未処理の発言を外せなかった');
  });

  it('404 は daemon の error をそのまま出して落ちる', async () => {
    replies.push({
      status: 404,
      body: { error: '会話が無い: conv-9', code: 'conversation_not_found' },
    });

    const error = await failureOf(conversationsDeleteCommand('conv-9', { yes: true }));

    expect(error.message).toBe('会話が無い: conv-9');
  });

  it('500 は状態コードと理由を出して落ちる', async () => {
    replies.push({ status: 500, body: { error: '壊れた' } });

    const error = await failureOf(conversationsDeleteCommand('conv-1', { yes: true }));

    expect(error.message).toContain('HTTP 500');
    expect(error.message).toContain('壊れた');
  });
});

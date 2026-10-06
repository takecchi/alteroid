import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid conversations` — CLI サブコマンドから会話の一覧・中身へ到達できること。
 *
 * **`fetch` を差し替えて、本物の型付きクライアント（`hono/client`）を通す。**
 * `memory.test.ts` と同じ形（手書きスタブを client の位置に置くと、経路名や
 * クエリの形が実物と一致していることを確かめられない）。
 */
vi.mock('./target.js', () => ({
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null }),
  describeAuthFailure: () => null,
}));

const { conversationsListCommand, conversationsReadCommand, conversationsShowCommand } =
  await import('./conversations.js');

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

/** 失敗（reject）した Error を取り出す。resolve したらテストを落とす。 */
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
    // `query` は常に渡す（型が要求する）。中身が空なら `hono/client`（4.13.5 以降。
    // `appendQueryParams` が空の searchParams のときは `?` を付けない）はクエリ無しの
    // URL をそのまま作る。
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/conversations');
    const text = read();
    expect(text).toContain('conv-1');
    expect(text).toContain('設計の相談');
    // scanned が無いと、返ってきた1件が「これで全部」に見えてしまう。
    expect(text).toContain('512');
    expect(text).toContain('conversations show');
    // **不在の側を必ず測る。** `reachedStart: true` / `hiddenByLimit: 0`
    // のときに断り書きが出ていたら、常時出ている注意書きになって意味が
    // 消える（#418 の裏返し）。
    expect(text).not.toContain('先頭には届いていない');
    expect(text).not.toContain('…ほか');
  });

  /**
   * **#418 の裏返し。** `GET /conversations` は `scan` の窓に加えて `limit`
   * でも黙って会話数を切っていた。サーバ（`hiddenByLimit`）とクローンの道具
   * （`conversation_read` の `hiddenByLimit`）は既に言っているので、CLI
   * サブコマンドだけが黙っていると端末では気づけない。
   */
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

  /**
   * #214: `startedAt`（作成）は `ConversationSummary` に元から在り、応答にも
   * 元から入っている。ここが出していなかっただけである。
   */
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

  /**
   * issue #2141 段1: ISO の横に経過を添える——「作成」「更新」の両方。
   * ISO はそのまま残る（消えていない）ことも合わせて確かめる。
   */
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

    // 失敗は例外で上へ通す（終了コードが 0 でなくなる。#2856）。
    await expect(conversationsListCommand({ limit: '0' })).rejects.toThrow('読めませんでした');
  });

  /**
   * #326: `renderConversationsList` 自体は改行で終わらずに返す（それは
   * `mutate-selftest.mjs` が固定している仕様）。呼び出し側（ここ）が `\n` を
   * 足すことで、端末の次のプロンプトや後続の書き込みが最終行へ食い込まない。
   */
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

  it('見える範囲に発言が無いときは、既読にせず理由を言う', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { ...detail, messages: [], reachedStart: false } });
    await conversationsReadCommand('conv-1');
    expect(sent).toHaveLength(1);
    expect(read()).toContain('既読にする発言が見つかりませんでした');
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

    // 会話の取得に続けて、その会話の承認を1回取る（#3261）。
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

  /**
   * 制約(A) — `supersededCount` は `--include-superseded` を渡さなくても
   * 常に出す（0件なら出さない）。出ないと、この会話に編集で畳まれた版が
   * 在ることに人間の側の器も気づけなくなる
   * （issue「チャットの送信済みメッセージを編集する」）。
   */
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

    // **既定では `includeSuperseded` を渡さない。** サーバ既定（false）と
    // 1バイトも違わない応答を、指定しなかった呼び出し全部に配らない。
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

  /**
   * `--include-superseded` を付けると、畳まれた発言も含めて返る
   * （デーモン側の約束）。**どれが畳まれた版でどの編集に置き換えられたかが
   * 読める**（`supersededBy` / `supersedes` の表示）ことと、**発言の id が
   * 読める**（編集の対象を指すのに要る）ことの両方をここで固定する。
   */
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

  /**
   * **「無い」と「判定できない」を混ぜない。** `messages` が空でも `reachedStart`
   * が偽なら、それは発言が無かったのではなく窓の外に残っているかもしれない、である
   * （`apps/daemon/src/app.ts` の `conversationDetailResponseSchema` の約束）。
   */
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

  /**
   * #326: `renderConversationDetail` 自体は改行で終わらずに返す（それは
   * `mutate-selftest.mjs` が固定している仕様）。呼び出し側（ここ）が `\n` を
   * 足すことで、次に書かれるものが最終行へ食い込まない（#314 で実際に融合した）。
   */
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
    // 回答のあとのクローンの返答は、承認の行の後ろに並ぶ。
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

/**
 * 読み出しの失敗は、固定の文言だけにせず、状態コードとデーモンの理由を載せる
 * （PR #2175 / PR #2256 の残り）。
 */
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

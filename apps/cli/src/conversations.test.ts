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

const { conversationsListCommand, conversationsShowCommand } = await import('./conversations.js');

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

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('GET');
    // `query` は常に渡す（型が要求する）。中身が空だと `hono/client` は `?` だけ
    // 付いた URL を作る — サーバ側には無害（クエリが無いのと同じに解釈される）。
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/conversations?');
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

  it('--limit / --scan をクエリへそのまま渡す', async () => {
    captureStdout();
    replies.push({
      status: 200,
      body: { conversations: [], scanned: 0, reachedStart: true, hiddenByLimit: 0 },
    });

    await conversationsListCommand({ limit: '5', scan: '9000' });

    expect(sent).toHaveLength(1);
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
    const read = captureStdout();
    replies.push({ status: 400, body: { error: 'invalid' } });

    await conversationsListCommand({ limit: '0' });

    expect(read()).toContain('読めませんでした');
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

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/conversations/conv-1?');
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
    const read = captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } });

    await conversationsShowCommand('conv-missing');

    expect(read()).toContain('そんな会話はありません: conv-missing');
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

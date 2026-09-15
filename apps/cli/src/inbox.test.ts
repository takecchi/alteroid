import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid inbox remove` — issue #972 の CLI 側の口。`POST /inbox/remove`
 * （PR #1007）をそのまま叩く薄いクライアントなので、ここで固定したいのは
 * サーバとの契約の写し間違い（送る本文の形・400/401/403 の言い換え）であって、
 * 絞り込みの判定そのもの（`matchesInboxRemoveManyFilter`）ではない
 * ——それは `packages/core/src/inbox-backlog.test.ts` が持つ。
 *
 * **既定が試算（dryRun）であることを歯で固定する。** `--execute` を渡さずに
 * 呼んだとき、送信した本文の `dryRun` が `true` であることを直接見る
 * ——文言だけを見るテストだと、本文の値を送り間違えても気づけない。
 */
vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({
      baseUrl: 'http://127.0.0.1:4517',
      headers: {},
      note: null,
      remote: false,
    }),
}));

const { inboxRemoveCommand } = await import('./inbox.js');

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

let sent: Sent[] = [];
let originalFetch: typeof fetch;
let replies: { status: number; body: unknown }[] = [];

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ url, method: init?.method ?? request.method ?? 'GET', body });
    const reply = replies.shift() ?? {
      status: 200,
      body: {
        ok: true,
        dryRun: true,
        totalPending: 0,
        matched: 0,
        targeted: 0,
        removedIds: [],
        remaining: 0,
      },
    };
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
  vi.clearAllMocks();
});

describe('alteroid inbox remove — 送る本文', () => {
  it('既定（--execute を渡さない）は dryRun: true を送る', async () => {
    await inboxRemoveCommand({ types: 'manager_message', reason: '滞留の掃除' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/inbox/remove');
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.body).toEqual({
      types: ['manager_message'],
      reason: '滞留の掃除',
      dryRun: true,
    });
  });

  it('--execute を渡すと dryRun: false を送る', async () => {
    await inboxRemoveCommand({ types: 'manager_message', reason: '滞留の掃除', execute: true });

    expect(sent[0]?.body).toEqual({
      types: ['manager_message'],
      reason: '滞留の掃除',
      dryRun: false,
    });
  });

  it('--types はカンマ区切りで配列へ、前後の空白を落とす', async () => {
    await inboxRemoveCommand({ types: ' manager_message , timer ', reason: 'r' });

    expect((sent[0]?.body as { types: string[] }).types).toEqual(['manager_message', 'timer']);
  });

  it('--sources / --before / --limit を渡すと本文に含める', async () => {
    await inboxRemoveCommand({
      types: 'external',
      sources: 'external:webhook-a, external:webhook-b',
      before: '2026-09-15T00:00:00.000Z',
      reason: 'r',
      limit: '50',
    });

    expect(sent[0]?.body).toEqual({
      types: ['external'],
      sources: ['external:webhook-a', 'external:webhook-b'],
      before: '2026-09-15T00:00:00.000Z',
      reason: 'r',
      dryRun: true,
      limit: 50,
    });
  });

  it('--sources / --before / --limit を渡さないときは本文にキーごと含めない', async () => {
    await inboxRemoveCommand({ types: 'external', reason: 'r' });

    const body = sent[0]?.body as Record<string, unknown>;
    expect('sources' in body).toBe(false);
    expect('before' in body).toBe(false);
    expect('limit' in body).toBe(false);
  });
});

describe('alteroid inbox remove — 入力の手前での断り（fetch を呼ばない）', () => {
  it('--types が空（カンマだけ等）なら断って fetch しない', async () => {
    const read = captureStdout();
    await inboxRemoveCommand({ types: ' , ', reason: 'r' });

    expect(sent).toHaveLength(0);
    expect(read()).toContain('--types に最低1種類');
  });

  it('--limit が整数でないなら断って fetch しない', async () => {
    const read = captureStdout();
    await inboxRemoveCommand({ types: 'timer', reason: 'r', limit: 'abc' });

    expect(sent).toHaveLength(0);
    expect(read()).toContain('--limit には1以上の整数');
  });

  it('--limit が0以下なら断って fetch しない', async () => {
    const read = captureStdout();
    await inboxRemoveCommand({ types: 'timer', reason: 'r', limit: '0' });

    expect(sent).toHaveLength(0);
  });
});

describe('alteroid inbox remove — 応答の表示', () => {
  it('試算（dryRun）の結果を件数つきで出し、1件も消していないと明言する', async () => {
    replies = [
      {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          totalPending: 30,
          matched: 12,
          targeted: 10,
          removedIds: ['e-1', 'e-2'],
          remaining: 2,
        },
      },
    ];
    const read = captureStdout();
    await inboxRemoveCommand({ types: 'manager_message', reason: 'r', limit: '10' });

    const text = read();
    expect(text).toContain('[試算]');
    expect(text).toContain('30 件中 12 件');
    expect(text).toContain('対象 10 件');
    expect(text).toContain('残り 2');
    // 上限で持ち越し
    expect(text).toContain('1件も消していません');
    // そのまま打てる次の一手（--execute 付き）を案内する
    expect(text).toContain('--execute');
    expect(text).toContain('alteroid inbox remove --types manager_message --reason "r" --limit 10 --execute');
  });

  it('実行（--execute）の結果は消した id を全部出す（打ち切らない）', async () => {
    const removedIds = Array.from({ length: 5 }, (_, index) => `e-${index}`);
    replies = [
      {
        status: 200,
        body: {
          ok: true,
          dryRun: false,
          totalPending: 5,
          matched: 5,
          targeted: 5,
          removedIds,
          remaining: 0,
        },
      },
    ];
    const read = captureStdout();
    await inboxRemoveCommand({ types: 'manager_message', reason: 'r', execute: true });

    const text = read();
    expect(text).not.toContain('[試算]');
    expect(text).not.toContain('1件も消していません');
    for (const id of removedIds) expect(text).toContain(id);
  });
});

describe('alteroid inbox remove — サーバの断りをそのまま出す', () => {
  it('400（絞り込みが無いのと同じ呼び等）はサーバの error 文言をそのまま出す', async () => {
    replies = [{ status: 400, body: { error: '絞り込みが無いのと同じ呼びは断る。1件も消していません。' } }];
    const read = captureStdout();
    await inboxRemoveCommand({
      types: 'human_message,human_answer,distill,timer,external,self_initiative,manager_message',
      reason: 'r',
    });

    expect(read()).toContain('絞り込みが無いのと同じ呼びは断る。1件も消していません。');
  });

  it('403 は access grant の案内を出す（describeAuthFailure と同じ文言）', async () => {
    replies = [{ status: 403, body: { error: 'このアカウントには alteroid を使う許可が無い' } }];
    const read = captureStdout();
    await inboxRemoveCommand({ types: 'timer', reason: 'r' });

    expect(read()).toContain('alteroid access grant');
  });
});

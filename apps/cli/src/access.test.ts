import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid access` — 誰が alteroid を使えるかを CLI から見えること。
 *
 * **`fetch` を差し替える。** `access.ts` は `hono/client` を使わず素の `fetch` を
 * 叩く（`request()`）ので、`conversations.test.ts` / `memory.test.ts` と同じ形で
 * `globalThis.fetch` を差し替える。
 */
vi.mock('./target.js', () => ({
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
  describeAuthFailure: () => null,
}));

const { accessListCommand } = await import('./access.js');

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

describe('alteroid access list', () => {
  /**
   * #214: `AccountView.createdAt` は元から型に在り、応答にも元から入っている
   * （`GET /access` の `accountWithIdentitiesSchema`）。ここが出していなかった
   * だけである。
   */
  it('作成（createdAt）を出す', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        accounts: [
          {
            id: 'acc-1',
            displayName: 'たけっち',
            email: 'takecchi@example.com',
            createdAt: '2026-08-01T00:00:00.000Z',
            lastLoginAt: '2026-08-20T09:00:00.000Z',
            grantedAt: '2026-08-01T00:05:00.000Z',
            granted: true,
            identities: [
              { provider: 'github', email: null, lastLoginAt: '2026-08-20T09:00:00.000Z' },
            ],
          },
        ],
      },
    });

    await accessListCommand();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/access');
    const text = read();
    expect(text).toContain('acc-1');
    expect(text).toContain('作成: 2026-08-01T00:00:00.000Z');
    // 既存の欄（最終ログイン・許可した日時）は消えていない。
    expect(text).toContain('最終ログイン: 2026-08-20T09:00:00.000Z');
    expect(text).toContain('許可した日時: 2026-08-01T00:05:00.000Z');
  });

  it('まだ誰もいなければ、そう言う', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { accounts: [] } });

    await accessListCommand();

    expect(read()).toContain('まだ誰もログインしていません');
  });
});

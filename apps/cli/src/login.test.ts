import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid login` / `logout` / `whoami` — #333。この3つはこれまでテストが
 * 1本も無かった（`apps/cli/src` で `.test.ts` を持たない3モジュールの1つ）。
 *
 * **`fetch` を差し替える。** `login.ts` は `hono/client` を使わず素の `fetch` を
 * 叩くので、`access.test.ts` / `conversations.test.ts` と同じ形にする。
 *
 * **`node:timers/promises` の `setTimeout`（`sleep` として import されている）と
 * `node:child_process` の `spawn`（`openBrowser` が使う）も差し替える。** どちらも
 * 差し替えないと、テストが `POLL_INTERVAL_MS`（1.5秒）だけ実際に待つか、この器に
 * 無い `xdg-open` を本当に起動しようとする。
 */
vi.mock('./target.js', () => ({
  // `vi.fn()` にしてあるのは、whoami の note 分岐だけ1件 `mockResolvedValueOnce`
  // で上書きしたいため（他の access/conversations/memory のテストは素の
  // arrow function で足りているが、こちらは呼び出しごとに違う応答が要る）。
  resolveTarget: vi.fn(() =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
  ),
  describeAuthFailure: () => null,
}));

vi.mock('./credentials.js', () => ({
  writeCredential: vi.fn(),
  readCredential: vi.fn(),
  clearCredential: vi.fn(),
}));

vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

const { loginCommand, logoutCommand, whoamiCommand } = await import('./login.js');
const target = await import('./target.js');
const credentials = await import('./credentials.js');

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
  vi.clearAllMocks();
});

describe('alteroid login', () => {
  it('デーモンが認証を要求していなければ、ログイン不要と言って何も打たずに返る', async () => {
    replies.push({ status: 200, body: { auth: { enabled: false, providers: [] } } });
    const read = captureStdout();

    await loginCommand({});

    const text = read();
    expect(text).toContain('は認証を要求していません（ログインは不要です）');
    // /health 以外は1件も打っていない（ここで止まった証拠）。
    expect(sent).toHaveLength(1);
  });

  it('ログインが完了し許可も既にあれば、成功とその旨を言う', async () => {
    replies.push(
      {
        status: 200,
        body: {
          auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth' }] },
        },
      },
      {
        status: 200,
        body: {
          requestId: 'req-1',
          authorizationUrl: 'https://accounts.example.com/auth?req=1',
          claimSecret: 'secret-1',
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
      },
      {
        status: 200,
        body: {
          status: 'ready',
          token: 'token-1',
          account: { id: 'acc-1', email: 'person@example.com', displayName: null },
          granted: true,
        },
      },
    );
    const read = captureStdout();

    await loginCommand({});

    const text = read();
    expect(text).toContain('ブラウザでログインしてください:');
    expect(text).toContain('https://accounts.example.com/auth?req=1');
    expect(text).toContain('ログインしました: person@example.com');
    expect(text).toContain('このアカウントは alteroid を使えます。');
    expect(text).not.toContain('alteroid access grant');
    expect(credentials.writeCredential).toHaveBeenCalledWith(
      'http://127.0.0.1:4517',
      expect.objectContaining({ token: 'token-1', accountId: 'acc-1' }),
    );
  });

  it('ログインは完了したが許可が無ければ、grant の手順まで案内する', async () => {
    replies.push(
      {
        status: 200,
        body: {
          auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth' }] },
        },
      },
      {
        status: 200,
        body: {
          requestId: 'req-2',
          authorizationUrl: 'https://accounts.example.com/auth?req=2',
          claimSecret: 'secret-2',
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
      },
      {
        status: 200,
        body: {
          status: 'ready',
          token: 'token-2',
          account: { id: 'acc-2', email: null, displayName: '山田' },
          granted: false,
        },
      },
    );
    const read = captureStdout();

    await loginCommand({});

    const text = read();
    expect(text).toContain('ログインしました: 山田');
    expect(text).toContain('まだ alteroid を使う許可がありません');
    expect(text).toContain('alteroid access grant acc-2');
  });
});

describe('alteroid logout', () => {
  it('手元のデーモンなら、消した事実に加えて実行環境の持ち主として繋がり続けることを言う', async () => {
    vi.mocked(credentials.clearCredential).mockResolvedValue(true);
    const read = captureStdout();

    await logoutCommand();

    const text = read();
    expect(text).toContain('http://127.0.0.1:4517 のログイン情報を消しました');
    expect(text).toContain('実行環境の持ち主として引き続き接続できます');
  });

  it('消すログイン情報が無ければ、無い旨だけを言う', async () => {
    vi.mocked(credentials.clearCredential).mockResolvedValue(false);
    const read = captureStdout();

    await logoutCommand();

    expect(read()).toContain('http://127.0.0.1:4517 のログイン情報はありません');
  });
});

describe('alteroid whoami', () => {
  it('実行環境の持ち主（operator）なら、その資格を言う', async () => {
    replies.push({ status: 200, body: { kind: 'operator' } });
    const read = captureStdout();

    await whoamiCommand();

    const text = read();
    expect(text).toContain('接続先: http://127.0.0.1:4517');
    expect(text).toContain('資格: 実行環境の持ち主（state/daemon.json を読めること）');
  });

  it('アカウントとして繋いでいれば、id・許可・保存済みログイン日時まで言う', async () => {
    replies.push({
      status: 200,
      body: {
        kind: 'account',
        account: { id: 'acc-3', email: 'who@example.com', displayName: null },
        granted: true,
      },
    });
    vi.mocked(credentials.readCredential).mockResolvedValue({
      token: 't',
      accountId: 'acc-3',
      label: 'who@example.com',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    const read = captureStdout();

    await whoamiCommand();

    const text = read();
    expect(text).toContain('資格: who@example.com');
    expect(text).toContain('アカウント id: acc-3');
    expect(text).toContain('許可: あり');
    expect(text).toContain('ログイン日時: 2026-08-01T00:00:00.000Z');
  });

  it('target.note が立っているとき（未ログインの remote 等）は、その note だけを言って返る', async () => {
    vi.mocked(target.resolveTarget).mockResolvedValueOnce({
      baseUrl: 'https://remote.example.com',
      headers: {},
      remote: true,
      note: 'https://remote.example.com にログインしていません（alteroid login）',
    });
    const read = captureStdout();

    await whoamiCommand();

    expect(read()).toBe('https://remote.example.com にログインしていません（alteroid login）\n');
    expect(sent).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

const { codexLoginCommand, codexLogoutCommand, codexStatusCommand } = await import('./codex.js');

interface Reply {
  status: number;
  body: unknown;
}

let replies: Map<string, Reply[]>;
let sent: { method: string; path: string }[];
let originalFetch: typeof fetch;

function setReplies(method: string, path: string, list: Reply[]): void {
  replies.set(`${method} ${path}`, list);
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  replies = new Map();
  sent = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    sent.push({ method, path });
    const list = replies.get(`${method} ${path}`) ?? [];
    const reply = (list.length > 1 ? list.shift() : list[0]) ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const PENDING = {
  id: 'L1',
  state: 'pending',
  verificationUrl: 'https://auth.example/device',
  userCode: 'ABCD-EFGH',
  startedAt: '2026-10-07T00:00:00.000Z',
  finishedAt: null,
  error: null,
};

const LOGGED_IN = {
  loggedIn: true,
  email: 'me@example.com',
  planType: 'plus',
  updatedAt: '2026-10-07T00:01:00.000Z',
  fingerprint: 'abcdef012345',
  failure: null,
};

describe('alteroid codex（#3939）', () => {
  it('login: URL とコードを出し、承認されるまで進み具合を見て、完了したら状態を出す', async () => {
    setReplies('POST', '/codex/login', [{ status: 200, body: PENDING }]);
    setReplies('GET', '/codex/login/L1', [
      { status: 200, body: PENDING },
      { status: 200, body: { ...PENDING, state: 'succeeded', finishedAt: 'x' } },
    ]);
    setReplies('GET', '/codex/auth', [{ status: 200, body: LOGGED_IN }]);
    const read = captureStdout();
    await codexLoginCommand({ sleep: async () => undefined, signal: new AbortController().signal });
    const text = read();
    expect(text).toContain('https://auth.example/device');
    expect(text).toContain('ABCD-EFGH');
    expect(text).toContain('ログインしました');
    expect(text).toContain('me@example.com');
    expect(sent.filter((s) => s.path === '/codex/login/L1')).toHaveLength(2);
  });

  it('login: 期限切れ・失敗は失敗として終わる', async () => {
    setReplies('POST', '/codex/login', [{ status: 200, body: PENDING }]);
    setReplies('GET', '/codex/login/L1', [{ status: 200, body: { ...PENDING, state: 'expired' } }]);
    captureStdout();
    await expect(
      codexLoginCommand({ sleep: async () => undefined, signal: new AbortController().signal }),
    ).rejects.toThrow(/期限が切れました/);
  });

  it('login: 中断したらデーモン側のログインを取り消す', async () => {
    setReplies('POST', '/codex/login', [{ status: 200, body: PENDING }]);
    setReplies('DELETE', '/codex/login/L1', [{ status: 200, body: { ...PENDING, state: 'canceled' } }]);
    const controller = new AbortController();
    controller.abort();
    captureStdout();
    await expect(
      codexLoginCommand({ sleep: async () => undefined, signal: controller.signal }),
    ).rejects.toThrow(/取り消しました/);
    expect(sent).toContainEqual({ method: 'DELETE', path: '/codex/login/L1' });
  });

  it('status: ログインしていなければ、無いこととログインの仕方を言う', async () => {
    setReplies('GET', '/codex/auth', [
      {
        status: 200,
        body: { ...LOGGED_IN, loggedIn: false, email: null, planType: null, fingerprint: null },
      },
    ]);
    const read = captureStdout();
    await codexStatusCommand();
    expect(read()).toContain('alteroid codex login');
  });

  it('status: 切れていたら再ログインを促す', async () => {
    setReplies('GET', '/codex/auth', [
      {
        status: 200,
        body: { ...LOGGED_IN, failure: { at: '2026-10-07T02:00:00.000Z', reason: 'token revoked' } },
      },
    ]);
    const read = captureStdout();
    await codexStatusCommand();
    const text = read();
    expect(text).toContain('token revoked');
    expect(text).toContain('再ログイン');
  });

  it('logout: --yes で消す。ログインしていなければ何もしない', async () => {
    setReplies('GET', '/codex/auth', [{ status: 200, body: LOGGED_IN }]);
    setReplies('DELETE', '/codex/auth', [{ status: 200, body: { removed: true } }]);
    const read = captureStdout();
    await codexLogoutCommand({ yes: true });
    expect(read()).toContain('消しました');
    expect(sent).toContainEqual({ method: 'DELETE', path: '/codex/auth' });

    sent = [];
    setReplies('GET', '/codex/auth', [{ status: 200, body: { ...LOGGED_IN, loggedIn: false } }]);
    captureStdout();
    await codexLogoutCommand({ yes: true });
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false);
  });
});

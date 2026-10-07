import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', () => ({
  resolveTarget: vi.fn(() =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
  ),
  describeAuthFailure: () => null,
  isRunnerContainer: vi.fn(() => false),
}));

vi.mock('./credentials.js', async () => ({
  CredentialsUnreadableError: (
    await vi.importActual<typeof import('./credentials.js')>('./credentials.js')
  ).CredentialsUnreadableError,
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

describe('alteroid login — 認可待ち中の一時的な失敗（#3727）', () => {
  const HEALTH = {
    auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth' }] },
  };
  const startBody = (expiresAt = '2999-01-01T00:00:00.000Z') => ({
    requestId: 'req-t',
    authorizationUrl: 'https://accounts.example.com/auth?req=t',
    claimSecret: 'secret-t',
    expiresAt,
  });
  const READY = {
    status: 'ready',
    token: 'token-t',
    account: { id: 'acc-t', email: 'person@example.com', displayName: null },
    granted: true,
  };
  type Step = { status: number; body: unknown } | { reject: Error };

  function stubSequence(claims: Step[], expiresAt?: string): void {
    const steps: Step[] = [
      { status: 200, body: HEALTH },
      { status: 200, body: startBody(expiresAt) },
      ...claims,
    ];
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      sent.push({ url, method: init?.method ?? 'GET' });
      const step = steps.shift();
      if (step === undefined) throw new Error('想定外の fetch');
      if ('reject' in step) return Promise.reject(step.reject);
      return Promise.resolve(
        new Response(JSON.stringify(step.body), {
          status: step.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch;
  }

  it('待ちの間に fetch が1回 reject しても、続けて ready を受ければログインできる', async () => {
    stubSequence([
      { reject: new TypeError('fetch failed') },
      { status: 202, body: { status: 'pending' } },
      { status: 200, body: READY },
    ]);
    const read = captureStdout();

    await loginCommand({});

    expect(credentials.writeCredential).toHaveBeenCalledWith(
      'http://127.0.0.1:4517',
      expect.objectContaining({ token: 'token-t' }),
    );
    expect(read()).toContain('待ちを続けています');
  });

  it('待ちの間の 502 / 429 でも、続けて ready を受ければログインできる', async () => {
    stubSequence([
      { status: 502, body: { error: 'bad gateway' } },
      { status: 429, body: {} },
      { status: 200, body: READY },
    ]);
    captureStdout();

    await loginCommand({});

    expect(credentials.writeCredential).toHaveBeenCalledTimes(1);
  });

  it('claimSecret 違いなどの 400 は、待っても直らないので即座に止まる', async () => {
    stubSequence([{ status: 400, body: { error: 'claimSecret が違う' } }]);
    captureStdout();

    await expect(loginCommand({})).rejects.toThrow('ログインに失敗しました: 400');
    expect(credentials.writeCredential).not.toHaveBeenCalled();
  });

  it('通信失敗の後の 400（引き取り済み）は、やり直しを案内する', async () => {
    stubSequence([
      { reject: new TypeError('fetch failed') },
      { status: 400, body: { error: 'ログイン要求が見つからない（既に引き取り済みの可能性）' } },
    ]);
    captureStdout();

    await expect(loginCommand({})).rejects.toThrow(/alteroid login をやり直してください/);
    expect(credentials.writeCredential).not.toHaveBeenCalled();
  });

  it('200 を受けた後に本文が読めなければ、再試行せずやり直しを案内して止まる', async () => {
    const steps: (() => Promise<Response>)[] = [
      () => Promise.resolve(Response.json(HEALTH)),
      () => Promise.resolve(Response.json(startBody())),
      () => Promise.resolve(new Response('{broken', { status: 200 })),
    ];
    let claimCalls = 0;
    globalThis.fetch = ((input: unknown) => {
      if (String(input).endsWith('/claim')) claimCalls += 1;
      const step = steps.shift();
      if (step === undefined) throw new Error('想定外の fetch');
      return step();
    }) as typeof fetch;
    captureStdout();

    await expect(loginCommand({})).rejects.toThrow(/alteroid login をやり直してください/);
    expect(claimCalls).toBe(1);
    expect(credentials.writeCredential).not.toHaveBeenCalled();
  });

  it('一時的な失敗が期限まで続けば、期限切れに「最後に繋がらなかった理由」を添えて止まる', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
      const timers = await import('node:timers/promises');
      vi.mocked(timers.setTimeout).mockImplementation(() => {
        vi.setSystemTime(Date.now() + 1500);
        return Promise.resolve(undefined);
      });
      const failing = Array.from({ length: 50 }, (): Step => ({
        reject: new TypeError('fetch failed'),
      }));
      stubSequence(failing, '2030-01-01T00:00:05.000Z');
      captureStdout();

      await expect(loginCommand({})).rejects.toThrow(/期限が切れました[\s\S]*fetch failed/);
      expect(credentials.writeCredential).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('alteroid logout', () => {
  const STORED = {
    token: 'tok-1',
    accountId: 'acc-1',
    label: 'person@example.com',
    createdAt: '2026-08-01T00:00:00.000Z',
  };

  it('手元に資格が無ければ、サーバへは何も呼ばずに「無い」旨と、手元デーモンの注記を言う', async () => {
    vi.mocked(credentials.readCredential).mockResolvedValue(null);
    const read = captureStdout();

    await logoutCommand();

    const text = read();
    expect(text).toContain('http://127.0.0.1:4517 のログイン情報はありません');
    expect(text).toContain('実行環境の持ち主として引き続き接続できます');
    expect(sent).toHaveLength(0);
  });

  it('成功（200）→ サーバ側を失効させたと言って、手元の資格も消す', async () => {
    vi.mocked(credentials.readCredential).mockResolvedValue(STORED);
    replies.push({ status: 200, body: { ok: true } });
    const read = captureStdout();

    await logoutCommand();

    expect(sent).toEqual([{ url: 'http://127.0.0.1:4517/auth/logout', method: 'POST' }]);
    expect(credentials.clearCredential).toHaveBeenCalledWith('http://127.0.0.1:4517');
    const text = read();
    expect(text).toContain('サーバ側のトークンを失効させ');
    expect(text).toContain('http://127.0.0.1:4517 のログイン情報を消しました');
  });

  it('401（既に無効）→ そう言って、手元の資格も消す', async () => {
    vi.mocked(credentials.readCredential).mockResolvedValue(STORED);
    replies.push({ status: 401, body: { error: 'トークンが無効か期限切れ' } });
    const read = captureStdout();

    await logoutCommand();

    expect(credentials.clearCredential).toHaveBeenCalledWith('http://127.0.0.1:4517');
    expect(read()).toContain('サーバ側では既に無効でした');
  });

  it('500 → 手元の資格を消さず、もう一度試すか --local-only を案内して失敗で終わる', async () => {
    vi.mocked(credentials.readCredential).mockResolvedValue(STORED);
    replies.push({ status: 500, body: { error: 'internal' } });

    await expect(logoutCommand()).rejects.toThrow('サーバ側のトークンをまだ失効できていません');
    expect(credentials.clearCredential).not.toHaveBeenCalled();
  });

  it('サーバへ届かない（接続拒否）→ 手元の資格を消さず、失敗で終わる', async () => {
    vi.mocked(credentials.readCredential).mockResolvedValue(STORED);
    globalThis.fetch = (() => Promise.reject(new Error('connect ECONNREFUSED'))) as typeof fetch;

    await expect(logoutCommand()).rejects.toThrow('サーバ側のトークンをまだ失効できていません');
    expect(credentials.clearCredential).not.toHaveBeenCalled();
  });

  it('--local-only → サーバへは呼ばず、警告を出して手元だけを消す', async () => {
    vi.mocked(credentials.readCredential).mockResolvedValue(STORED);
    const read = captureStdout();

    await logoutCommand({ localOnly: true });

    expect(sent).toHaveLength(0);
    expect(credentials.readCredential).not.toHaveBeenCalled();
    expect(credentials.clearCredential).toHaveBeenCalledWith(
      'http://127.0.0.1:4517',
      expect.any(Function),
    );
    const text = read();
    expect(text).toContain('--local-only');
    expect(text).toContain('手元のログイン情報だけを消しました');
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

  it('runner の器の中で手元のデーモンに繋いでいれば、本番ではない旨を1行足す', async () => {
    vi.mocked(target.isRunnerContainer).mockReturnValueOnce(true);
    replies.push({ status: 200, body: { kind: 'operator' } });
    const read = captureStdout();

    await whoamiCommand();

    const text = read();
    expect(text).toContain('この接続は runner の器の中の手元のデーモンです（本番ではありません）');
  });

  it('runner の外（既定の isRunnerContainer が false）では、その1行を足さない', async () => {
    replies.push({ status: 200, body: { kind: 'operator' } });
    const read = captureStdout();

    await whoamiCommand();

    expect(read()).not.toContain('runner の器の中');
  });

  it('remote（ALTEROID_URL）に繋いでいるときは、isRunnerContainer が true でもその1行を足さない', async () => {
    vi.mocked(target.isRunnerContainer).mockReturnValueOnce(true);
    vi.mocked(target.resolveTarget).mockResolvedValueOnce({
      baseUrl: 'https://remote.example.com',
      headers: { authorization: 'Bearer t' },
      remote: true,
      note: null,
    });
    replies.push({ status: 200, body: { kind: 'operator' } });
    const read = captureStdout();

    await whoamiCommand();

    expect(read()).not.toContain('runner の器の中');
  });
});

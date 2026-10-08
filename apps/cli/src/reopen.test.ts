import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async () => {
  const actual = await vi.importActual<typeof import('./target.js')>('./target.js');
  return {
    ...actual,
    resolveTarget: vi.fn(() =>
      Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
    ),
  };
});

const { reopenCommand, describeReopenResult, buildReopenConfirmMessage } =
  await import('./reopen.js');
const target = await import('./target.js');

interface Sent {
  url: string;
  method: string;
  body?: string;
}

let sent: Sent[] = [];
let originalFetch: typeof fetch;
let replies: { status: number; body: unknown }[] = [];

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string; text?: () => Promise<string> };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    const entry: Sent = { url, method: init?.method ?? request.method ?? 'GET' };
    sent.push(entry);
    if (typeof init?.body === 'string') entry.body = init.body;
    else if (typeof request.text === 'function') {
      void request.text().then((text) => {
        entry.body = text;
      });
    }
    const reply = replies.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

function io(answer: string, isTTY = true) {
  const written: string[] = [];
  return {
    written,
    io: {
      isTTY,
      write: (text: string) => {
        written.push(text);
      },
      ask: () => Promise.resolve(answer),
    },
  };
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

describe('describeReopenResult', () => {
  it('3値をそれぞれ言い分ける', () => {
    expect(describeReopenResult({ outcome: 'deferred' })).toContain('境界で');
    expect(describeReopenResult({ outcome: 'now' })).toContain('次の合図から新しいセッション');
    expect(describeReopenResult({ outcome: 'unsupported' })).toContain('持っていない');
  });

  it('走っているマネージャーがいれば止めていないと言う。0 本や取れなかったときは言わない', () => {
    expect(describeReopenResult({ outcome: 'deferred', runningManagers: 2 })).toContain(
      'マネージャーは止めていない',
    );
    expect(describeReopenResult({ outcome: 'deferred', runningManagers: 0 })).not.toContain(
      'マネージャー',
    );
    expect(describeReopenResult({ outcome: 'deferred' })).not.toContain('マネージャー');
  });

  it('古いセッション id を出す', () => {
    expect(describeReopenResult({ outcome: 'now', previousSessionId: 'sess-1' })).toContain(
      'sess-1',
    );
  });
});

describe('buildReopenConfirmMessage', () => {
  it('蒸留の既定（しない）と --distill を言い分ける', () => {
    expect(buildReopenConfirmMessage({})).toContain('蒸留しません');
    expect(buildReopenConfirmMessage({ distill: true })).toContain('蒸留します');
  });
});

describe('reopenCommand', () => {
  it('ログインしていなければ note を載せて reject し、確認も呼び出しもしない', async () => {
    vi.mocked(target.resolveTarget).mockResolvedValueOnce({
      baseUrl: 'https://runner.example.com',
      headers: {},
      note: 'https://runner.example.com にログインしていません（alteroid login）',
      remote: true,
    });
    const read = captureStdout();

    await expect(reopenCommand({ yes: true })).rejects.toThrow('ログインしていません');

    expect(sent).toHaveLength(0);
    expect(read()).toBe('');
  });

  it('--yes なら確認せず、confirm: true・distill・reason を本文に載せて POST し、結果を書く', async () => {
    replies.push({
      status: 200,
      body: { outcome: 'deferred', previousSessionId: 'sess-1', runningManagers: 1 },
    });
    const read = captureStdout();

    await reopenCommand({ yes: true, distill: true, reason: '弾かれ続けている' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain('/clone/session/reopen');
    expect(sent[0]?.method).toBe('POST');
    await vi.waitFor(() => expect(sent[0]?.body).toBeDefined());
    expect(JSON.parse(sent[0]?.body ?? 'null')).toEqual({
      confirm: true,
      distill: true,
      reason: '弾かれ続けている',
    });
    const out = read();
    expect(out).toContain('境界で');
    expect(out).toContain('sess-1');
    expect(out).toContain('マネージャーは止めていない');
  });

  it('既定では distill も reason も本文に載せない（蒸留しない既定はデーモンが持つ）', async () => {
    replies.push({ status: 200, body: { outcome: 'now' } });
    captureStdout();

    await reopenCommand({ yes: true });

    await vi.waitFor(() => expect(sent[0]?.body).toBeDefined());
    expect(JSON.parse(sent[0]?.body ?? 'null')).toEqual({ confirm: true });
  });

  it('端末で yes と答えれば呼ぶ。答えなければ何も呼ばず、取り消しを伝える', async () => {
    replies.push({ status: 200, body: { outcome: 'now' } });
    captureStdout();
    const approved = io('yes');
    await reopenCommand({}, approved.io);
    expect(sent).toHaveLength(1);
    expect(approved.written.join('')).toContain('resume せずに開き直しますか');

    sent = [];
    const declined = io('no');
    await expect(reopenCommand({}, declined.io)).rejects.toThrow('取り消しました');
    expect(sent).toHaveLength(0);
  });

  it('端末でなく --yes も無ければ、呼ばずに --yes を案内して失敗する', async () => {
    captureStdout();
    await expect(reopenCommand({}, io('yes', false).io)).rejects.toThrow('--yes');
    expect(sent).toHaveLength(0);
  });

  it('200 + unsupported はそのまま書く（成功と偽らない）', async () => {
    replies.push({ status: 200, body: { outcome: 'unsupported' } });
    const read = captureStdout();
    await reopenCommand({ yes: true });
    expect(read()).toContain('持っていない');
  });

  it('403（未許可）は access grant の案内、400 は理由つきで例外を投げる', async () => {
    replies.push({ status: 403, body: {} });
    captureStdout();
    await expect(reopenCommand({ yes: true })).rejects.toThrow(
      'このアカウントには alteroid を使う許可がありません。',
    );

    replies.push({ status: 400, body: { error: 'reason は 1〜500 字' } });
    await expect(reopenCommand({ yes: true })).rejects.toThrow('reason は 1〜500 字');
  });
});

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

const { interruptCommand, describeInterruptOutcome } = await import('./interrupt.js');
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
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    sent.push({
      url,
      method: init?.method ?? request.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
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

describe('describeInterruptOutcome', () => {
  it('3値をそれぞれ言い分ける', () => {
    expect(describeInterruptOutcome('interrupted')).toContain('止めた');
    expect(describeInterruptOutcome('idle')).toContain('無かった');
    expect(describeInterruptOutcome('unsupported')).toContain('持っていない');
  });
});

describe('interruptCommand', () => {
  it('ログインしていなければ note を載せて reject し（終了コード非 0）、stdout には書かず、interrupt を叩かない（#2456）', async () => {
    vi.mocked(target.resolveTarget).mockResolvedValueOnce({
      baseUrl: 'https://runner.example.com',
      headers: {},
      note: 'https://runner.example.com にログインしていません（alteroid login）',
      remote: true,
    });
    const read = captureStdout();

    await expect(interruptCommand()).rejects.toThrow(
      'https://runner.example.com にログインしていません（alteroid login）',
    );

    expect(sent).toHaveLength(0);
    expect(read()).toBe('');
  });

  it('200 + interrupted なら止めた旨を書く', async () => {
    replies.push({ status: 200, body: { outcome: 'interrupted' } });
    const read = captureStdout();

    await interruptCommand();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain('/clone/interrupt');
    expect(sent[0]?.method).toBe('POST');
    expect(read()).toContain('止めた');
  });

  it('200 + idle / unsupported も、それぞれの文言をそのまま書く（成功と偽らない）', async () => {
    replies.push({ status: 200, body: { outcome: 'idle' } });
    const read1 = captureStdout();
    await interruptCommand();
    expect(read1()).toContain('無かった');

    replies.push({ status: 200, body: { outcome: 'unsupported' } });
    const read2 = captureStdout();
    await interruptCommand();
    expect(read2()).toContain('持っていない');
  });

  it('デーモンが 500 を返したら例外を投げる（終了コードが 0 でなくなる）。文言は従来の表示文言の意味を保つ', async () => {
    replies.push({ status: 500, body: { error: '内部エラー' } });
    captureStdout();

    await expect(interruptCommand()).rejects.toThrow(
      'クローンのターンを止められませんでした（HTTP 500）',
    );
    replies.push({ status: 500, body: { error: '内部エラー' } });
    await expect(interruptCommand()).rejects.toThrow('内部エラー');
  });

  it('401 は describeAuthFailure の文言で例外を投げる（ログインし直す案内）', async () => {
    replies.push({ status: 401, body: {} });
    captureStdout();

    await expect(interruptCommand()).rejects.toThrow(
      '認証されませんでした。デーモンを起動し直してください（alteroid daemon stop && alteroid chat）',
    );
  });

  it('403（未許可）は describeAuthFailure の文言で例外を投げる（access grant の案内）', async () => {
    replies.push({ status: 403, body: {} });
    captureStdout();

    await expect(interruptCommand()).rejects.toThrow(
      'このアカウントには alteroid を使う許可がありません。',
    );
  });
});

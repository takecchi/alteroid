import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * Issue #1621: `alteroid interrupt`（`POST /clone/interrupt`。走行中のクローンの
 * ターンを止める副作用のある操作）が HTTP の 4xx/5xx を握り潰し、終了コードを
 * 0 のまま返していた。
 *
 * この repo には「書き込み系コマンドは失敗を握り潰さない」という明文の規約が
 * ある——`apps/cli/src/inbox.ts`（`inboxRemoveCommand`）の doc 逐語:
 * 「失敗は例外で上へ通す（＝終了コードが 0 でなくなる）。…そもそも繋がら
 * なかったときでさえ終了コードが 0 になり、スクリプトや cron から失敗を
 * 検知できない。…既存の変更系（reset.ts / access.ts / token.ts）は全部
 * この形である」。`interrupt.ts` だけがこの規約から外れていた（このファイル
 * 自体、修正前は試験が1本も無かった）。
 *
 * `interrupt.ts` を `!response.ok` で `throw new Error(...)`（`describeAuthFailure`
 * を経由）する形に直したので、ここではその挙動を固定する。
 */
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
  it('ログインしていなければ note をそのまま書き、interrupt を叩かない（reset 等とは別の門だが、inboxRemoveCommand と同じ2段構え）', async () => {
    vi.mocked(target.resolveTarget).mockResolvedValueOnce({
      baseUrl: 'https://runner.example.com',
      headers: {},
      note: 'https://runner.example.com にログインしていません（alteroid login）',
      remote: true,
    });
    const read = captureStdout();

    await interruptCommand();

    expect(sent).toHaveLength(0);
    expect(read()).toBe('https://runner.example.com にログインしていません（alteroid login）\n');
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

  /**
   * #1621 の本体: 500（＝ `describeAuthFailure` が判定できない、素の失敗）は
   * 例外として投げ、文言は修正前の表示文言の意味を保つ。
   */
  it('デーモンが 500 を返したら例外を投げる（終了コードが 0 でなくなる）。文言は従来の表示文言の意味を保つ', async () => {
    replies.push({ status: 500, body: { error: '内部エラー' } });
    captureStdout();

    await expect(interruptCommand()).rejects.toThrow(
      'クローンのターンを止められませんでした（HTTP 500）',
    );
  });

  /**
   * 401 は `describeAuthFailure` の判定に委ねる（`reset.ts` 等と同じ）。
   * `/clone/interrupt` は `authenticate` だけが門なので、`forbiddenKindOf` は
   * 呼ばずに丸投げしてよい（`chat.ts` / `inbox.ts` と同じ判断）。
   */
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

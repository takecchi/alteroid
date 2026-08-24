import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid token` — Issue #393「PR1 プールの器」。**回さない**——ここで固定する
 * のは器を覗く・並べる・外す口の見た目だけで、検知・切替は無い。
 *
 * `profile.test.ts` と同じ作法——`fetch` を `method + path` の応答表で差し替える。
 * `token.ts` も同じコマンドの中で複数経路（`GET /tokens` → `PUT /tokens`）を
 * 打つので、`access.test.ts` の「先入れ先出しで積む」形は合わない。
 */
vi.mock('./target.js', () => ({
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
  describeAuthFailure: () => null,
}));

const {
  tokenListCommand,
  tokenAddCommand,
  tokenRemoveCommand,
  tokenDisableCommand,
  tokenEnableCommand,
  tokenPolicyCommand,
} = await import('./token.js');

interface Reply {
  status: number;
  body: unknown;
}

let replies: Map<string, Reply>;
let sent: { url: string; method: string; body: unknown }[];
let originalFetch: typeof fetch;

function setReply(method: string, path: string, reply: Reply): void {
  replies.set(`${method} ${path}`, reply);
}

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    const method = init?.method ?? request.method ?? 'GET';
    const path = new URL(url).pathname;
    const body =
      typeof init?.body === 'string' && init.body.length > 0
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    sent.push({ url, method, body });
    const reply = replies.get(`${method} ${path}`) ?? { status: 200, body: {} };
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
  replies = new Map();
  sent = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const EMPTY_SETTINGS = { rotateOn: 'free_exhausted', cooldownMs: 18_000_000 };

describe('alteroid token list', () => {
  it('プールが空なら、無いことと登録の仕方を言う（値の話は一切出ない）', async () => {
    setReply('GET', '/tokens', { status: 200, body: { tokens: [], settings: EMPTY_SETTINGS } });
    const read = captureStdout();

    await tokenListCommand();

    const text = read();
    expect(text).toContain('回す契機: free_exhausted');
    expect(text).toContain('トークンは登録されていません');
    expect(text).toContain('alteroid token add --label <名前> --file <path>');
  });

  it('登録済みの行を order 順に並べ、状態（外された・冷却中・失効・最後の拒否）を出す。値は一切出ない', async () => {
    const now = Date.now();
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [
          {
            id: 'tok-b',
            label: 'second',
            order: 1,
            sha256: 'bbbbbbbbbbbb',
          },
          {
            id: 'tok-a',
            label: 'first',
            order: 0,
            sha256: 'aaaaaaaaaaaa',
            disabledAt: '2026-08-01T00:00:00.000Z',
            cooldownUntil: now + 60_000,
            lastRejectedAt: '2026-08-02T00:00:00.000Z',
            lastRejectedReason: 'rate_limit exceeded',
            invalidatedAt: '2026-08-03T00:00:00.000Z',
            invalidatedReason: 'account_on_hold',
          },
        ],
        settings: { rotateOn: 'overage_exhausted', cooldownMs: 1_000 },
      },
    });
    const read = captureStdout();

    await tokenListCommand();

    const text = read();
    // 順序は order 昇順（first が先）。
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text).toContain('id=tok-a');
    expect(text).toContain('sha256=aaaaaaaaaaaa');
    expect(text).toContain('外されている');
    expect(text).toContain('失効: account_on_hold');
    expect(text).toContain('冷却中');
    expect(text).toContain('最後の拒否: rate_limit exceeded');
    // 値はどこにも出ない（本文にトークン本体を書かないという約束の検算）。
    expect(text).not.toContain('tok-aaa');
  });

  it('置いた時刻・最後の更新・回復の見込みを出す。見込みには実測でない旨を同じ行に添える（Issue #393）', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [
          {
            id: 'tok-a',
            label: 'first',
            order: 0,
            sha256: 'aaaaaaaaaaaa',
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-25T03:00:00.000Z',
            lastRejectedAt: '2026-08-25T03:00:00.000Z',
            lastRejectedReason: "You've hit your org's monthly spend limit",
            recovery: 'time',
          },
        ],
        settings: EMPTY_SETTINGS,
      },
    });

    const read = captureStdout();

    await tokenListCommand();

    const text = read();
    expect(text).toContain('置いた 2026-08-01T00:00:00.000Z');
    expect(text).toContain('最後の更新 2026-08-25T03:00:00.000Z');
    expect(text).toContain('見込み: 時間で戻る');
    // **断りは同じ行に在ること。** 実測（文言・時刻）の隣に置いた判定は、行ごと
    // 実測として読まれる（AGENTS.md「報告の形」）。行を跨いだ断りでは効かない。
    const verdictLine = text.split('\n').find((line) => line.includes('見込み: 時間で戻る'));
    expect(verdictLine).toContain('実測ではない');
  });

  it('置いた時刻が無い行（PR1 の版で置かれた行）では、その行を出さない', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-a', label: 'first', order: 0, sha256: 'aaaaaaaaaaaa' }],
        settings: EMPTY_SETTINGS,
      },
    });

    const read = captureStdout();

    await tokenListCommand();

    // 取れなかったものを「不明」で埋めない。
    expect(read()).not.toContain('置いた');
  });
});

describe('alteroid token add', () => {
  it('ファイルの内容を value として PUT する。既存の行は value を省略して引き継ぐ', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-existing', label: 'existing', order: 0, sha256: 'ffffffffffff' }],
        settings: EMPTY_SETTINGS,
      },
    });
    setReply('PUT', '/tokens', {
      status: 200,
      body: {
        tokens: [
          { id: 'tok-existing', label: 'existing', order: 0, sha256: 'ffffffffffff' },
          { id: 'tok-new', label: 'new-one', order: 1, sha256: 'eeeeeeeeeeee' },
        ],
        settings: EMPTY_SETTINGS,
      },
    });

    const dir = await mkdtemp(join(tmpdir(), 'alteroid-token-add-'));
    const path = join(dir, 'token.txt');
    await writeFile(path, 'tok-aaa-secret\n', 'utf8');
    const read = captureStdout();

    try {
      await tokenAddCommand({ label: 'new-one', file: path });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(read()).toContain('トークン「new-one」を追加しました。');

    const put = sent.find((call) => call.method === 'PUT' && call.url.endsWith('/tokens'));
    expect(put?.body).toEqual({
      tokens: [
        { id: 'tok-existing', label: 'existing', order: 0 },
        { label: 'new-one', value: 'tok-aaa-secret' },
      ],
    });
  });

  it('値が空（ファイルが空・空白のみ）なら投げる。PUT を打たない', async () => {
    setReply('GET', '/tokens', { status: 200, body: { tokens: [], settings: EMPTY_SETTINGS } });
    const dir = await mkdtemp(join(tmpdir(), 'alteroid-token-add-empty-'));
    const path = join(dir, 'empty.txt');
    await writeFile(path, '   \n', 'utf8');

    try {
      await expect(tokenAddCommand({ label: 'x', file: path })).rejects.toThrow('値が空である');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(sent.some((call) => call.method === 'PUT')).toBe(false);
  });
});

describe('alteroid token remove', () => {
  it('id を指定して削除する（PUT からその行が落ちる）', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [
          { id: 'tok-a', label: 'a', order: 0, sha256: 'aaaaaaaaaaaa' },
          { id: 'tok-b', label: 'b', order: 1, sha256: 'bbbbbbbbbbbb' },
        ],
        settings: EMPTY_SETTINGS,
      },
    });
    setReply('PUT', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-b', label: 'b', order: 1, sha256: 'bbbbbbbbbbbb' }],
        settings: EMPTY_SETTINGS,
      },
    });
    const read = captureStdout();

    await tokenRemoveCommand('tok-a');

    expect(read()).toContain('トークン（id tok-a）を削除しました。');
    const put = sent.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({ tokens: [{ id: 'tok-b', label: 'b', order: 1 }] });
  });

  it('無い id を指定したら、見つからないと言うだけで PUT は打たない', async () => {
    setReply('GET', '/tokens', { status: 200, body: { tokens: [], settings: EMPTY_SETTINGS } });
    const read = captureStdout();

    await tokenRemoveCommand('ghost');

    expect(read()).toContain('id ghost のトークンは見つかりません。');
    expect(sent.some((call) => call.method === 'PUT')).toBe(false);
  });
});

describe('alteroid token disable / enable', () => {
  it('disable は指定した行にだけ disabled:true を立てて PUT する', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [
          { id: 'tok-a', label: 'a', order: 0, sha256: 'aaaaaaaaaaaa' },
          { id: 'tok-b', label: 'b', order: 1, sha256: 'bbbbbbbbbbbb' },
        ],
        settings: EMPTY_SETTINGS,
      },
    });
    setReply('PUT', '/tokens', { status: 200, body: { tokens: [], settings: EMPTY_SETTINGS } });
    const read = captureStdout();

    await tokenDisableCommand('tok-a');

    expect(read()).toContain('トークン（id tok-a）を外しました。');
    const put = sent.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({
      tokens: [
        { id: 'tok-a', label: 'a', order: 0, disabled: true },
        { id: 'tok-b', label: 'b', order: 1 },
      ],
    });
  });

  it('enable は disabled:false を立てて戻す', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-a', label: 'a', order: 0, sha256: 'aaaaaaaaaaaa' }],
        settings: EMPTY_SETTINGS,
      },
    });
    setReply('PUT', '/tokens', { status: 200, body: { tokens: [], settings: EMPTY_SETTINGS } });
    const read = captureStdout();

    await tokenEnableCommand('tok-a');

    expect(read()).toContain('トークン（id tok-a）を戻しました。');
    const put = sent.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({ tokens: [{ id: 'tok-a', label: 'a', order: 0, disabled: false }] });
  });
});

describe('alteroid token policy', () => {
  it('引数無しなら、いまの設定を GET から出すだけ（PUT は打たない）', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: { tokens: [], settings: { rotateOn: 'off', cooldownMs: 42 } },
    });
    const read = captureStdout();

    await tokenPolicyCommand(undefined, {});

    const text = read();
    expect(text).toContain('回す契機: off');
    expect(text).toContain('42ms');
    expect(sent.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('値を渡すと PUT /tokens/policy へ部分更新として送る', async () => {
    setReply('PUT', '/tokens/policy', {
      status: 200,
      body: { rotateOn: 'overage_exhausted', cooldownMs: 18_000_000 },
    });
    const read = captureStdout();

    await tokenPolicyCommand('overage_exhausted', {});

    expect(read()).toContain('回す契機: overage_exhausted');
    const put = sent.find((call) => call.method === 'PUT' && call.url.endsWith('/tokens/policy'));
    expect(put?.body).toEqual({ rotateOn: 'overage_exhausted' });
  });

  it('--cooldown-ms も渡せる。0以下や非数は投げる', async () => {
    setReply('PUT', '/tokens/policy', {
      status: 200,
      body: { rotateOn: 'free_exhausted', cooldownMs: 5_000 },
    });
    captureStdout();

    await tokenPolicyCommand(undefined, { cooldownMs: '5000' });
    const put = sent.find((call) => call.method === 'PUT' && call.url.endsWith('/tokens/policy'));
    expect(put?.body).toEqual({ cooldownMs: 5_000 });

    await expect(tokenPolicyCommand(undefined, { cooldownMs: '0' })).rejects.toThrow(
      '--cooldown-ms',
    );
    await expect(tokenPolicyCommand(undefined, { cooldownMs: 'abc' })).rejects.toThrow(
      '--cooldown-ms',
    );
  });
});

describe('403（実行環境の持ち主だけ）', () => {
  it('専用の文言を出す（access grant とは別の資格だと分かる形で）', async () => {
    setReply('GET', '/tokens', { status: 403, body: { error: 'forbidden' } });

    await expect(tokenListCommand()).rejects.toThrow('実行環境の持ち主だけです');
  });
});

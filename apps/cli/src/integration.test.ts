import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid integration` — 連携の鍵の一覧・発行・失効（#3113 段2）。
 *
 * 固定するのは次の各点:
 *
 * 1. `create` は値を**1回だけ**書き（「二度と表示されない」の直下）、送り方の例には値を書かない
 * 2. 入力の誤り（source の形・期限・上限）はデーモンへ送る前に断る（何も作らない）
 * 3. `list` は値を出さない。状態は有効 / 失効 / 期限切れ
 * 4. `revoke` は既定で `yes` を確認し、`--yes` で飛ばせる。確認で止めたら POST しない
 * 5. 失敗の文言に値を出さない
 *
 * `mcp.test.ts` と同じ作法 — `fetch` を差し替え、本物の hono client を通す。
 */
vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

const {
  integrationListCommand,
  integrationCreateCommand,
  integrationRevokeCommand,
  integrationKeyStatus,
  parseExpires,
} = await import('./integration.js');

interface Reply {
  status: number;
  body: unknown;
}

let replies: Map<string, Reply>;
let sent: { method: string; path: string; body: unknown }[];
let originalFetch: typeof fetch;

function setReply(method: string, path: string, reply: Reply): void {
  replies.set(`${method} ${path}`, reply);
}

function stubFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = typeof input === 'string' ? input : (request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? 'GET';
    const path = new URL(url).pathname;
    const raw =
      typeof init?.body === 'string' ? init.body : request !== null ? await request.text() : '';
    sent.push({ method, path, body: raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined });
    const reply = replies.get(`${method} ${path}`) ?? { status: 200, body: {} };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const NOW = Date.parse('2026-10-01T00:00:00.000Z');
const SECRET_VALUE = 'altk_SECRETVALUE0123456789';

function view(over: Record<string, unknown> = {}) {
  return {
    id: 'k-1',
    name: 'CI',
    source: 'ci.main',
    fingerprint: 'abcdef012345',
    createdAt: '2026-09-30T00:00:00.000Z',
    createdBy: '実行環境の持ち主による操作',
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    limits: { maxBodyBytes: 1_048_576, ratePerMinute: 60 },
    ...over,
  };
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

describe('integration list', () => {
  it('名前・source・状態・期限・最終使用・指紋を出し、値は出ない', async () => {
    setReply('GET', '/integration-keys', {
      status: 200,
      body: {
        keys: [
          view(),
          view({ id: 'k-2', name: '古い', revokedAt: '2026-09-30T12:00:00.000Z' }),
          view({ id: 'k-3', name: '切れた', expiresAt: '2026-09-30T01:00:00.000Z' }),
          view({ id: 'k-4', name: '使った', lastUsedAt: '2026-09-30T05:00:00.000Z' }),
        ],
      },
    });
    const out = captureStdout();
    await integrationListCommand(NOW);
    const text = out();
    expect(text).toContain('連携の鍵: 4 件');
    expect(text).toContain('[有効] CI  source=ci.main');
    expect(text).toContain('[失効] 古い');
    expect(text).toContain('[期限切れ] 切れた');
    expect(text).toContain('最終使用: 2026-09-30T05:00:00.000Z');
    expect(text).toContain('期限: （無期限）');
    expect(text).toContain('指紋: abcdef012345');
    expect(text).toContain('本文 1048576 バイト・60 回/分');
    expect(text).not.toContain('altk_');
  });

  it('0件なら発行の案内を出す', async () => {
    setReply('GET', '/integration-keys', { status: 200, body: { keys: [] } });
    const out = captureStdout();
    await integrationListCommand(NOW);
    expect(out()).toContain('alteroid integration create');
  });

  it('401 は認証の案内、500 は理由つきで失敗する', async () => {
    setReply('GET', '/integration-keys', { status: 401, body: {} });
    await expect(integrationListCommand(NOW)).rejects.toThrow('認証されませんでした');
    setReply('GET', '/integration-keys', { status: 500, body: { error: '壊れた' } });
    await expect(integrationListCommand(NOW)).rejects.toThrow('(500): 壊れた');
  });
});

describe('integration create', () => {
  it('値を1回だけ書き、二度と表示されない旨と送り方の例を添える（値は例に書かない）', async () => {
    setReply('POST', '/integration-keys', {
      status: 200,
      body: { key: view(), value: SECRET_VALUE },
    });
    const out = captureStdout();
    await integrationCreateCommand({ name: 'CI', source: 'ci.main' }, NOW);
    const text = out();
    expect(text.split(SECRET_VALUE)).toHaveLength(2); // ちょうど1回
    expect(text).toContain('二度と表示されません');
    expect(text).toContain('curl -X POST http://127.0.0.1:4517/events/ci.main');
    expect(text).toContain('Authorization: Bearer $ALTEROID_INTEGRATION_KEY');
    // 接続先は外のサービスから届く値とは限らない（#3210）。例であることを添える。
    expect(text).toContain('自分の公開 URL に置き換えてください');
    expect(sent).toEqual([
      { method: 'POST', path: '/integration-keys', body: { name: 'CI', source: 'ci.main' } },
    ]);
  });

  it('期限（期間・日時）と上限を送る', async () => {
    setReply('POST', '/integration-keys', {
      status: 200,
      body: { key: view(), value: SECRET_VALUE },
    });
    captureStdout();
    await integrationCreateCommand(
      { name: ' CI ', source: 'ci.main', expires: '30d', maxBodyBytes: '2048', ratePerMinute: '5' },
      NOW,
    );
    expect(sent[0]?.body).toEqual({
      name: 'CI',
      source: 'ci.main',
      expiresAt: '2026-10-31T00:00:00.000Z',
      maxBodyBytes: 2048,
      ratePerMinute: 5,
    });
  });

  it('入力の誤りはデーモンへ送らずに断る', async () => {
    captureStdout();
    const base = { name: 'CI', source: 'ci.main' };
    await expect(integrationCreateCommand({ ...base, source: 'CI Main' }, NOW)).rejects.toThrow(
      '--source',
    );
    await expect(integrationCreateCommand({ ...base, name: '  ' }, NOW)).rejects.toThrow('--name');
    await expect(integrationCreateCommand({ ...base, expires: 'あした' }, NOW)).rejects.toThrow(
      '--expires',
    );
    await expect(integrationCreateCommand({ ...base, maxBodyBytes: '0' }, NOW)).rejects.toThrow(
      '--max-body-bytes',
    );
    await expect(integrationCreateCommand({ ...base, ratePerMinute: 'x' }, NOW)).rejects.toThrow(
      '--rate-per-minute',
    );
    expect(sent).toEqual([]);
  });

  it('400 はデーモンの理由を出し、値はどこにも出ない', async () => {
    setReply('POST', '/integration-keys', {
      status: 400,
      body: { error: 'expiresAt が過去（何も作っていない）' },
    });
    const out = captureStdout();
    await expect(
      integrationCreateCommand({ name: 'CI', source: 'ci.main', expires: '2020-01-01' }, NOW),
    ).rejects.toThrow('expiresAt が過去');
    expect(out()).not.toContain('altk_');
  });
});

describe('integration revoke', () => {
  const list = { status: 200, body: { keys: [view()] } };

  it('yes と答えると POST する', async () => {
    setReply('GET', '/integration-keys', list);
    setReply('POST', '/integration-keys/k-1/revoke', {
      status: 200,
      body: { key: view({ revokedAt: '2026-10-01T00:00:00.000Z' }) },
    });
    const out = captureStdout();
    const ask = vi.fn(() => Promise.resolve('yes'));
    await integrationRevokeCommand('k-1', { ask });
    expect(ask).toHaveBeenCalledOnce();
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /integration-keys',
      'POST /integration-keys/k-1/revoke',
    ]);
    expect(out()).toContain('失効させました: CI');
  });

  it('yes 以外なら POST せず、何も変えていないと言う', async () => {
    setReply('GET', '/integration-keys', list);
    const out = captureStdout();
    await integrationRevokeCommand('k-1', { ask: () => Promise.resolve('y') });
    expect(sent.map((s) => s.method)).toEqual(['GET']);
    expect(out()).toContain('何も変更していません');
  });

  it('--yes は確認を飛ばして POST する', async () => {
    setReply('POST', '/integration-keys/k-1/revoke', {
      status: 200,
      body: { key: view({ revokedAt: '2026-10-01T00:00:00.000Z' }) },
    });
    captureStdout();
    const ask = vi.fn(() => Promise.resolve('no'));
    await integrationRevokeCommand('k-1', { yes: true, ask });
    expect(ask).not.toHaveBeenCalled();
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /integration-keys/k-1/revoke']);
  });

  it('無い id は断る（確認前は一覧で、--yes では 404 で）', async () => {
    setReply('GET', '/integration-keys', list);
    await expect(
      integrationRevokeCommand('nope', { ask: () => Promise.resolve('yes') }),
    ).rejects.toThrow('該当する連携の鍵がありません');
    setReply('POST', '/integration-keys/nope/revoke', {
      status: 404,
      body: { error: 'not found' },
    });
    await expect(integrationRevokeCommand('nope', { yes: true })).rejects.toThrow(
      '該当する連携の鍵がありません',
    );
  });

  it('すでに失効済みなら確認せずにそう言う', async () => {
    setReply('GET', '/integration-keys', {
      status: 200,
      body: { keys: [view({ revokedAt: '2026-09-30T12:00:00.000Z' })] },
    });
    const out = captureStdout();
    const ask = vi.fn(() => Promise.resolve('yes'));
    await integrationRevokeCommand('k-1', { ask });
    expect(ask).not.toHaveBeenCalled();
    expect(out()).toContain('すでに失効しています');
  });
});

describe('parseExpires / integrationKeyStatus', () => {
  it('期間は now からの ISO、日付は ISO にそろえ、読めないものは断る', () => {
    expect(parseExpires('90m', NOW)).toBe('2026-10-01T01:30:00.000Z');
    expect(parseExpires('2w', NOW)).toBe('2026-10-15T00:00:00.000Z');
    expect(parseExpires('2027-01-01T00:00:00Z', NOW)).toBe('2027-01-01T00:00:00.000Z');
    expect(() => parseExpires('0d', NOW)).toThrow('期間が不正');
    expect(() => parseExpires('1y', NOW)).toThrow('読めませんでした');
  });

  it('失効が期限切れより先、判定できない期限は期限切れ', () => {
    expect(integrationKeyStatus({ revokedAt: 'x', expiresAt: '2020-01-01T00:00:00Z' }, NOW)).toBe(
      'revoked',
    );
    expect(integrationKeyStatus({ revokedAt: null, expiresAt: 'ぐちゃ' }, NOW)).toBe('expired');
    expect(integrationKeyStatus({ revokedAt: null, expiresAt: null }, NOW)).toBe('active');
  });
});

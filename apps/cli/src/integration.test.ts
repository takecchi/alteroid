import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfirmIo } from './confirm.js';
import { captureStdout } from './test-support.js';

/**
 * `alteroid integration` — 連携の鍵の一覧・発行・失効（#3113 段2）。
 *
 * 固定するのは次の各点:
 *
 * 1. `create` は値を**1回だけ**書き（「二度と表示されない」の直下）、送り方の例には値を書かない
 * 2. 入力の誤り（source の形・期限・上限）はデーモンへ送る前に断る（何も作らない）
 * 3. `list` は値を出さない。状態は有効 / 失効 / 期限切れ
 * 4. `revoke` は `confirmIrreversible`（端末なら yes、`--yes` で省略、非対話で `--yes` 無しは断る）。存在と失効済みの確認は `--yes` でも行う。確認で止めたら POST しない
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

  it('400 の理由がすでに括弧で終わっていれば、「（何も変更していません）」を重ねない', async () => {
    setReply('POST', '/integration-keys', {
      status: 400,
      body: { error: 'expiresAt が過去（何も作っていない）' },
    });
    captureStdout();
    const create = integrationCreateCommand(
      { name: 'CI', source: 'ci.main', expires: '2020-01-01' },
      NOW,
    );
    await expect(create).rejects.toThrow(/^expiresAt が過去（何も作っていない）$/);
    setReply('POST', '/integration-keys', { status: 400, body: { error: 'expiresAt が過去' } });
    await expect(
      integrationCreateCommand({ name: 'CI', source: 'ci.main', expires: '2020-01-01' }, NOW),
    ).rejects.toThrow(/^expiresAt が過去（何も変更していません）$/);
  });
});

describe('integration revoke', () => {
  const list = { status: 200, body: { keys: [view()] } };
  const revokedList = {
    status: 200,
    body: { keys: [view({ revokedAt: '2026-09-30T12:00:00.000Z' })] },
  };
  const calls = () => sent.map((s) => `${s.method} ${s.path}`);

  /** 確認の口。`isTTY` と答えを差し込む（`confirmIrreversible` の `ConfirmIo`）。 */
  function fakeIo(isTTY: boolean, answer = '') {
    const ask = vi.fn(() => Promise.resolve(answer));
    const io: ConfirmIo = { isTTY, write: (text) => process.stdout.write(text), ask };
    return { io, ask };
  }

  it('端末で yes と答えると POST する（resolveTarget → 一覧 → 確認 → POST の順）', async () => {
    setReply('GET', '/integration-keys', list);
    setReply('POST', '/integration-keys/k-1/revoke', {
      status: 200,
      body: { key: view({ revokedAt: '2026-10-01T00:00:00.000Z' }) },
    });
    const out = captureStdout();
    const { io, ask } = fakeIo(true, 'yes');
    await integrationRevokeCommand('k-1', { io });
    expect(ask).toHaveBeenCalledOnce();
    expect(calls()).toEqual(['GET /integration-keys', 'POST /integration-keys/k-1/revoke']);
    expect(out()).toContain('連携の鍵「CI」（source=ci.main）を失効させます');
    expect(out()).toContain('失効させました: CI');
  });

  it('端末で yes 以外なら POST せず、何も変えていないと言う', async () => {
    setReply('GET', '/integration-keys', list);
    const out = captureStdout();
    const { io } = fakeIo(true, 'y');
    await integrationRevokeCommand('k-1', { io });
    expect(calls()).toEqual(['GET /integration-keys']);
    expect(out()).toContain('何も変更していません');
  });

  it('端末でなく --yes も無ければ、標準入力の yes では通さず、POST せずに断る（非 0）', async () => {
    // 以前は `echo yes | alteroid integration revoke <id>` で失効した（#3211。他の戻せない操作は断る）。
    setReply('GET', '/integration-keys', list);
    captureStdout();
    const { io, ask } = fakeIo(false, 'yes');
    await expect(integrationRevokeCommand('k-1', { io })).rejects.toThrow('--yes');
    expect(ask).not.toHaveBeenCalled();
    expect(calls()).toEqual(['GET /integration-keys']);
  });

  it('--yes は確認を飛ばすが、存在の確認（一覧）はしてから POST する', async () => {
    setReply('GET', '/integration-keys', list);
    setReply('POST', '/integration-keys/k-1/revoke', {
      status: 200,
      body: { key: view({ revokedAt: '2026-10-01T00:00:00.000Z' }) },
    });
    captureStdout();
    const { io, ask } = fakeIo(false, 'no');
    await integrationRevokeCommand('k-1', { yes: true, io });
    expect(ask).not.toHaveBeenCalled();
    expect(calls()).toEqual(['GET /integration-keys', 'POST /integration-keys/k-1/revoke']);
  });

  it('無い id は、確認前も --yes でも、POST せずに断る', async () => {
    setReply('GET', '/integration-keys', list);
    await expect(integrationRevokeCommand('nope', { io: fakeIo(true, 'yes').io })).rejects.toThrow(
      '該当する連携の鍵がありません',
    );
    await expect(integrationRevokeCommand('nope', { yes: true })).rejects.toThrow(
      '該当する連携の鍵がありません（何も失効していません）',
    );
    expect(calls()).toEqual(['GET /integration-keys', 'GET /integration-keys']);
  });

  it('すでに失効済みなら、確認も --yes も関係なくそう言い、POST しない（成功の 0。取り消しは何度叩いても同じ状態になる）', async () => {
    setReply('GET', '/integration-keys', revokedList);
    const out = captureStdout();
    const { io, ask } = fakeIo(true, 'yes');
    await integrationRevokeCommand('k-1', { io });
    await integrationRevokeCommand('k-1', { yes: true });
    expect(ask).not.toHaveBeenCalled();
    expect(out().match(/すでに失効しています/g)).toHaveLength(2);
    expect(calls()).toEqual(['GET /integration-keys', 'GET /integration-keys']);
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

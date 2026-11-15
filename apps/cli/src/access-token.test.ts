import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfirmIo } from './confirm.js';
import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({
      baseUrl: 'https://alteroid.example.com:8443',
      headers: {},
      note: null,
      remote: true,
    }),
}));

const {
  accessTokenListCommand,
  accessTokenCreateCommand,
  accessTokenRevokeCommand,
  mcpServerConfig,
} = await import('./access-token.js');

interface Reply {
  status: number;
  body: unknown;
}

let replies: Map<string, Reply>;
let sent: { method: string; path: string; query: string; body: unknown }[];
let originalFetch: typeof fetch;

function setReply(method: string, path: string, reply: Reply): void {
  replies.set(`${method} ${path}`, reply);
}

function stubFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(typeof input === 'string' ? input : (request?.url ?? String(input)));
    const method = init?.method ?? request?.method ?? 'GET';
    const raw =
      typeof init?.body === 'string' ? init.body : request !== null ? await request.text() : '';
    sent.push({
      method,
      path: url.pathname,
      query: url.search,
      body: raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined,
    });
    const reply = replies.get(`${method} ${url.pathname}`) ?? { status: 200, body: {} };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const NOW = Date.parse('2026-10-01T00:00:00.000Z');
const SECRET_VALUE = 'alt_SECRETVALUE0123456789';

function view(over: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    accountId: 'acc-1',
    name: '別環境',
    kind: 'read',
    origin: 'issued',
    issuedBy: 'operator',
    fingerprint: 'abcdef0123456789',
    createdAt: '2026-09-30T00:00:00.000Z',
    expiresAt: '2026-10-30T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    ...over,
  };
}

function captureStderr(): () => string {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join('');
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

describe('access-token list', () => {
  it('名前・種類・発行元・状態・期限・最終使用・指紋の先頭12桁・id を出し、値は出ない', async () => {
    setReply('GET', '/access-tokens', {
      status: 200,
      body: {
        tokens: [
          view(),
          view({ id: 't-2', name: 'ログイン', origin: 'login', issuedBy: null, kind: 'full' }),
          view({ id: 't-3', name: '古い', revokedAt: '2026-09-30T12:00:00.000Z' }),
          view({ id: 't-4', name: '切れた', expiresAt: '2026-09-30T01:00:00.000Z' }),
          view({
            id: 't-5',
            name: '無期限',
            expiresAt: null,
            lastUsedAt: '2026-09-30T05:00:00.000Z',
          }),
        ],
      },
    });
    const out = captureStdout();
    await accessTokenListCommand({}, NOW);
    const text = out();
    expect(text).toContain('アクセストークン: 5 件');
    expect(text).toContain('[有効] 別環境  種類=read  発行元=発行（operator）');
    expect(text).toContain('[有効] ログイン  種類=full  発行元=ログイン');
    expect(text).toContain('[失効] 古い');
    expect(text).toContain('[期限切れ] 切れた');
    expect(text).toContain('期限: （無期限）');
    expect(text).toContain('最終使用: 2026-09-30T05:00:00.000Z');
    expect(text).toContain('指紋: abcdef012345\n');
    expect(text).not.toContain('abcdef0123456');
    expect(text).toContain('id: t-1');
    expect(text).not.toContain('alt_');
  });

  it('--account は accountId クエリで送る。省略なら付けない', async () => {
    setReply('GET', '/access-tokens', { status: 200, body: { tokens: [] } });
    const out = captureStdout();
    await accessTokenListCommand({ account: 'acc-9' }, NOW);
    await accessTokenListCommand({}, NOW);
    expect(sent.map((s) => s.query)).toEqual(['?accountId=acc-9', '']);
    expect(out()).toContain('alteroid access-token create');
  });

  it('operator が --account なしで 400 になったら --account を案内する', async () => {
    setReply('GET', '/access-tokens', {
      status: 400,
      body: { error: '実行環境の持ち主の資格では accountId が要る' },
    });
    await expect(accessTokenListCommand({}, NOW)).rejects.toThrow('--account');
  });
});

describe('access-token create', () => {
  const created = () => ({ status: 200, body: { token: view(), value: SECRET_VALUE } });

  it('値の行は1つで二度と表示されない旨を添え、read の案内と MCP の JSON（origin と Bearer）を出す', async () => {
    setReply('POST', '/access-tokens', created());
    const out = captureStdout();
    await accessTokenCreateCommand({ name: '別環境' }, NOW);
    const text = out();
    expect(text).toContain('二度と表示されません');
    expect(text).toContain(`\n  ${SECRET_VALUE}\n`);
    // 値の行と、貼るための MCP の JSON の2か所だけ
    expect(text.split(SECRET_VALUE)).toHaveLength(3);
    expect(text).toContain('読むだけ。通るのは記憶・日誌・利用・/self/prompt の読み取りと /mcp');
    expect(text).not.toContain('ログインのトークンと同じ強さ');
    const jsonText = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    expect(text).toContain('名前を alteroid-remote にしてあるのは');
    expect(JSON.parse(jsonText)).toEqual({
      'alteroid-remote': {
        type: 'http',
        url: 'https://alteroid.example.com:8443/mcp',
        headers: { Authorization: `Bearer ${SECRET_VALUE}` },
      },
    });
    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/access-tokens',
        query: '',
        body: { name: '別環境', kind: 'read' },
      },
    ]);
  });

  it('full は強さと、発行トークンからは発行できない旨を案内する', async () => {
    setReply('POST', '/access-tokens', {
      status: 200,
      body: { token: view({ kind: 'full' }), value: SECRET_VALUE },
    });
    const out = captureStdout();
    await accessTokenCreateCommand({ name: 'x', kind: 'full' }, NOW);
    const text = out();
    expect(text).toContain('ログインのトークンと同じ強さ');
    expect(text).toContain('発行トークンからは新しいトークンを発行できません');
    expect(text).not.toContain('読むだけ。');
    expect(sent[0]?.body).toEqual({ name: 'x', kind: 'full' });
  });

  it('--json: 標準出力は応答の JSON（token・value）に mcp を足したもの。警告は標準エラーへ、値は警告に入らない', async () => {
    setReply('POST', '/access-tokens', created());
    const out = captureStdout();
    const err = captureStderr();
    await accessTokenCreateCommand({ name: '別環境', json: true }, NOW);
    const parsed = JSON.parse(out()) as {
      token: { id: string };
      value: string;
      mcp: { 'alteroid-remote': { url: string; headers: { Authorization: string } } };
    };
    expect(parsed.value).toBe(SECRET_VALUE);
    expect(parsed.token.id).toBe('t-1');
    expect(Object.keys(parsed.mcp)).toEqual(['alteroid-remote']);
    expect(parsed.mcp['alteroid-remote'].url).toBe('https://alteroid.example.com:8443/mcp');
    expect(parsed.mcp['alteroid-remote'].headers.Authorization).toBe(`Bearer ${SECRET_VALUE}`);
    expect(err()).toContain('二度と表示されません');
    expect(err()).toContain('ログに残さない');
    expect(err()).not.toContain(SECRET_VALUE);
  });

  it('--expires: 省略は expiresAt を送らず（サーバの既定30日）、期間・日時は ISO で、never だけ null を送る', async () => {
    setReply('POST', '/access-tokens', created());
    captureStdout();
    await accessTokenCreateCommand({ name: 'a' }, NOW);
    await accessTokenCreateCommand({ name: 'b', expires: '30d' }, NOW);
    await accessTokenCreateCommand({ name: 'c', expires: '2027-01-01T00:00:00Z' }, NOW);
    await accessTokenCreateCommand({ name: 'd', expires: 'never' }, NOW);
    expect(sent.map((s) => s.body)).toEqual([
      { name: 'a', kind: 'read' },
      { name: 'b', kind: 'read', expiresAt: '2026-10-31T00:00:00.000Z' },
      { name: 'c', kind: 'read', expiresAt: '2027-01-01T00:00:00.000Z' },
      { name: 'd', kind: 'read', expiresAt: null },
    ]);
  });

  it('--account は accountId として送る（アカウントの資格では省略）', async () => {
    setReply('POST', '/access-tokens', created());
    captureStdout();
    await accessTokenCreateCommand({ name: 'a', account: ' acc-1 ' }, NOW);
    expect(sent[0]?.body).toEqual({ name: 'a', kind: 'read', accountId: 'acc-1' });
  });

  it('入力の誤り（名前・kind・expires・account）はデーモンへ送らずに断る', async () => {
    captureStdout();
    await expect(accessTokenCreateCommand({ name: '  ' }, NOW)).rejects.toThrow('--name');
    await expect(accessTokenCreateCommand({ name: 'a', kind: 'admin' }, NOW)).rejects.toThrow(
      '--kind は read か full',
    );
    await expect(accessTokenCreateCommand({ name: 'a', kind: 'READ' }, NOW)).rejects.toThrow(
      '--kind',
    );
    await expect(accessTokenCreateCommand({ name: 'a', expires: 'あした' }, NOW)).rejects.toThrow(
      '--expires',
    );
    await expect(accessTokenCreateCommand({ name: 'a', expires: '0d' }, NOW)).rejects.toThrow(
      '期間が不正',
    );
    await expect(accessTokenCreateCommand({ name: 'a', expires: 'Never' }, NOW)).rejects.toThrow(
      '--expires',
    );
    await expect(accessTokenCreateCommand({ name: 'a', account: ' ' }, NOW)).rejects.toThrow(
      '--account',
    );
    expect(sent).toEqual([]);
  });

  it('発行したトークンの資格で 403 になったら、使えない旨と代わりの資格を言う（値はどこにも出ない）', async () => {
    setReply('POST', '/access-tokens', {
      status: 403,
      body: {
        error:
          '発行したアクセストークンでは、アクセストークンの発行・一覧・失効はできない（人間のログインの資格か…）',
      },
    });
    const out = captureStdout();
    const create = accessTokenCreateCommand({ name: 'a' }, NOW);
    await expect(create).rejects.toThrow('発行したアクセストークンからは');
    await expect(accessTokenCreateCommand({ name: 'a' }, NOW)).rejects.toThrow('alteroid login');
    expect(out()).not.toContain('alt_');
  });

  it('operator が --account なしだと、400 の理由に --account の案内を足す', async () => {
    setReply('POST', '/access-tokens', {
      status: 400,
      body: { error: '実行環境の持ち主の資格では accountId が要る' },
    });
    await expect(accessTokenCreateCommand({ name: 'a' }, NOW)).rejects.toThrow('--account');
  });
});

describe('mcpServerConfig', () => {
  it('url は接続先の origin（パス・末尾スラッシュを除く）に /mcp', () => {
    expect(mcpServerConfig('http://127.0.0.1:4517/', 'v')['alteroid-remote'].url).toBe(
      'http://127.0.0.1:4517/mcp',
    );
    expect(mcpServerConfig('https://a.example/x/y', 'v')['alteroid-remote'].url).toBe(
      'https://a.example/mcp',
    );
  });
});

describe('access-token revoke', () => {
  const list = { status: 200, body: { tokens: [view()] } };
  const revokedList = {
    status: 200,
    body: { tokens: [view({ revokedAt: '2026-09-30T12:00:00.000Z' })] },
  };
  const calls = () => sent.map((s) => `${s.method} ${s.path}${s.query}`);

  function fakeIo(isTTY: boolean, answer = '') {
    const ask = vi.fn(() => Promise.resolve(answer));
    const io: ConfirmIo = { isTTY, write: (text) => process.stdout.write(text), ask };
    return { io, ask };
  }

  it('端末で yes と答えると POST する（一覧 → 確認 → POST の順。--account はクエリで両方に付く）', async () => {
    setReply('GET', '/access-tokens', list);
    setReply('POST', '/access-tokens/t-1/revoke', {
      status: 200,
      body: { token: view({ revokedAt: '2026-10-01T00:00:00.000Z' }) },
    });
    const out = captureStdout();
    const { io, ask } = fakeIo(true, 'yes');
    await accessTokenRevokeCommand('t-1', { account: 'acc-1', io });
    expect(ask).toHaveBeenCalledOnce();
    expect(calls()).toEqual([
      'GET /access-tokens?accountId=acc-1',
      'POST /access-tokens/t-1/revoke?accountId=acc-1',
    ]);
    expect(out()).toContain('アクセストークン「別環境」（種類=read）を失効させます');
    expect(out()).toContain('失効させました: 別環境');
  });

  it('端末で yes 以外なら POST せず、端末でなく --yes も無ければ断る。--yes は確認を飛ばす', async () => {
    setReply('GET', '/access-tokens', list);
    setReply('POST', '/access-tokens/t-1/revoke', {
      status: 200,
      body: { token: view({ revokedAt: '2026-10-01T00:00:00.000Z' }) },
    });
    captureStdout();
    await expect(accessTokenRevokeCommand('t-1', { io: fakeIo(true, 'y').io })).rejects.toThrow(
      '何も変更していません',
    );
    const noTty = fakeIo(false, 'yes');
    await expect(accessTokenRevokeCommand('t-1', { io: noTty.io })).rejects.toThrow('--yes');
    expect(noTty.ask).not.toHaveBeenCalled();
    expect(calls()).toEqual(['GET /access-tokens', 'GET /access-tokens']);
    await accessTokenRevokeCommand('t-1', { yes: true, io: fakeIo(false).io });
    expect(calls().at(-1)).toBe('POST /access-tokens/t-1/revoke');
  });

  it('無い id は POST せずに断る。失効済みは確認なしでそう言い、POST しない（冪等）', async () => {
    setReply('GET', '/access-tokens', list);
    await expect(accessTokenRevokeCommand('nope', { yes: true })).rejects.toThrow(
      '該当するアクセストークンがありません（何も失効していません）',
    );
    setReply('GET', '/access-tokens', revokedList);
    const out = captureStdout();
    const { io, ask } = fakeIo(true, 'yes');
    await accessTokenRevokeCommand('t-1', { io });
    await accessTokenRevokeCommand('t-1', { yes: true });
    expect(ask).not.toHaveBeenCalled();
    expect(out().match(/すでに失効しています/g)).toHaveLength(2);
    expect(calls().filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('発行したトークンの資格で 403 になったら、使えない旨を言う', async () => {
    setReply('GET', '/access-tokens', {
      status: 403,
      body: { error: '発行したアクセストークンでは、アクセストークンの発行・一覧・失効はできない' },
    });
    await expect(accessTokenRevokeCommand('t-1', { yes: true })).rejects.toThrow(
      'alteroid login した人か、実行環境の持ち主の資格',
    );
  });
});

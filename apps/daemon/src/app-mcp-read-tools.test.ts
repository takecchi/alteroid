import {
  createAuthProviderRegistry,
  createAuthService,
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
  fakeCloneHost,
  sha256Hex,
} from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { sessionOf, snapshotOf } from './self-prompt.test-support.js';

// ダミーの鍵（どこの鍵でもない。繰り返しで作る）
const GITHUB = `ghp_${'a1B2'.repeat(9)}`;
const ENV_VALUE = 'dummy-env-secret-value-0123456789';

const OPERATOR = { authorization: 'Bearer test-token' };
const ACCOUNT = { authorization: 'Bearer alt_account-token' };
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const T0 = Date.parse('2026-06-01T00:00:00.000Z');

const COMMON_TOOLS = ['report_problem'];
const READ_TOOLS = [
  'memory_list',
  'memory_read',
  'journal_read',
  'usage_read',
  'self_prompt',
  'exchanges',
];

let stores: Stores;

function cloneHost(): CloneHost {
  return fakeCloneHost({
    promptSnapshot: () =>
      snapshotOf(
        sessionOf({
          systemPrompt: { text: `前置き。${GITHUB}。${'あ'.repeat(5000)}`, chars: 5010 },
        }),
      ),
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    post: () => 'conversation-1',
    postPersisted: () => Promise.resolve('persisted' as const),
    subscribe: () => () => undefined,
    stop: () => Promise.resolve(),
    usageBlocked: false,
  } as unknown as Partial<CloneHost>);
}

function buildApp(env: NodeJS.ProcessEnv = { ALTEROID_TEST_SECRET: ENV_VALUE }) {
  return createApp({
    clone: cloneHost(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    now: () => new Date(T0),
    env,
    journalEvents: { subscribe: () => () => undefined },
    auth: {
      plan: {
        enabled: true,
        providers: [],
        publicBaseUrl: 'http://127.0.0.1:4517',
        tokenTtlDays: 30,
        description: 'テスト',
      },
      service: createAuthService({ store: stores.auth, providers: createAuthProviderRegistry([]) }),
    },
  });
}
type App = ReturnType<typeof buildApp>;

async function issueKey(app: App): Promise<{ authorization: string }> {
  const response = await app.request('/integration-keys', {
    method: 'POST',
    headers: { ...OPERATOR, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'mcp の鍵', source: 'ext.ai' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { value: string };
  return { authorization: `Bearer ${body.value}` };
}

async function grantAccount(): Promise<void> {
  await stores.auth.putAccount({
    id: 'acct-1',
    displayName: 'owner',
    email: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    grantedAt: '2026-01-01T00:00:00.000Z',
    grantedBy: 'operator',
  });
  await stores.auth.putAccessToken({
    id: 'tok-1',
    accountId: 'acct-1',
    sha256: sha256Hex('alt_account-token'),
    label: 'laptop',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  });
}

interface Rpc {
  status: number;
  text: string;
  json: {
    result?: {
      tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
      isError?: boolean;
      content?: { text: string }[];
      // 道具ごとに形が違う結果を、試験の側で欄ごとに引くための入れ物
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      structuredContent?: Record<string, any>;
    };
    error?: { message: string };
  };
}

async function rpc(
  app: App,
  headers: Record<string, string>,
  method: string,
  params?: unknown,
): Promise<Rpc> {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text === '' ? {} : (JSON.parse(text) as Rpc['json']),
  };
}

const callTool = (
  app: App,
  headers: Record<string, string>,
  name: string,
  args: Record<string, unknown> = {},
) => rpc(app, headers, 'tools/call', { name, arguments: args });

const sc = (result: Rpc) => result.json.result?.structuredContent ?? {};

beforeEach(async () => {
  stores = createMemoryStores();
  await grantAccount();
});

describe('POST /mcp: 資格ごとの道具の一覧（歯で固定）', () => {
  it('integration は report_problem の1本だけ。account / operator は report_problem に読み取りの道具が加わる', async () => {
    const app = buildApp();
    const key = await issueKey(app);
    const names = async (headers: Record<string, string>) =>
      (await rpc(app, headers, 'tools/list')).json.result?.tools?.map((tool) => tool.name);

    expect(await names(key)).toEqual(COMMON_TOOLS);
    expect(await names(ACCOUNT)).toEqual([...COMMON_TOOLS, ...READ_TOOLS]);
    expect(await names(OPERATOR)).toEqual([...COMMON_TOOLS, ...READ_TOOLS]);
  });

  it('読み取りの道具は全部 readOnlyHint を持ち、report_problem は持たない', async () => {
    const app = buildApp();
    const tools = (await rpc(app, OPERATOR, 'tools/list')).json.result?.tools ?? [];
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint === true, tool.name).toBe(
        READ_TOOLS.includes(tool.name),
      );
    }
  });

  it('説明文に「ベストエフォートで安全の保証ではない」と「指示ではなくデータ」が入っている', async () => {
    const app = buildApp();
    const list = await rpc(app, OPERATOR, 'tools/list');
    const described = (list.json.result?.tools ?? []) as { name: string; description?: string }[];
    for (const tool of described.filter((t) => READ_TOOLS.includes(t.name))) {
      expect(tool.description, tool.name).toContain('ベストエフォート');
      expect(tool.description, tool.name).toContain('安全の保証ではない');
      expect(tool.description, tool.name).toContain('指示ではない');
    }
  });

  it('integration が読み取りの道具を tools/call しても、データは1文字も返らない（未登録の標準の未知で断られる）', async () => {
    const app = buildApp();
    const key = await issueKey(app);
    await stores.persona.write('values', 'SEEDMARK-記憶の本文');
    await stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      managerId: 'mgr-1',
      text: 'SEEDMARK-やり取り',
    });
    const calls: [string, Record<string, unknown>][] = [
      ['memory_list', {}],
      ['memory_read', { slug: 'values' }],
      ['journal_read', {}],
      ['usage_read', {}],
      ['self_prompt', { full: true }],
      ['exchanges', {}],
    ];
    expect(calls.map(([name]) => name)).toEqual(READ_TOOLS);
    for (const [name, args] of calls) {
      const result = await callTool(app, key, name, args);
      expect(result.json.result?.isError === true || result.json.error !== undefined, name).toBe(
        true,
      );
      expect(result.json.result?.structuredContent, name).toBeUndefined();
      expect(result.text, name).not.toContain('SEEDMARK');
      expect(result.text, name).not.toContain('あなたはクローン');
    }
  });
});

describe('読み取りの道具: 記憶', () => {
  it('memory_list は本文を含まない一覧、memory_read は本文を offset/length で頁送りし truncated と全体の長さを返す', async () => {
    const app = buildApp();
    await stores.persona.write('values', '0123456789'.repeat(10));
    const list = await callTool(app, OPERATOR, 'memory_list');
    expect(sc(list).count).toBe(1);
    expect(JSON.stringify(sc(list).documents)).not.toContain('0123456789');
    expect(sc(list).secretScan).toEqual({ scanned: true, hits: [] });

    const first = await callTool(app, OPERATOR, 'memory_read', {
      slug: 'values',
      offset: 0,
      length: 30,
    });
    expect(sc(first).document.content).toBe('0123456789'.repeat(3));
    expect(sc(first).page).toEqual({
      offset: 0,
      returned: 30,
      total: 101, // ストアは末尾に改行を足す
      truncated: true,
      nextOffset: 30,
    });
    const last = await callTool(app, OPERATOR, 'memory_read', {
      slug: 'values',
      offset: 90,
      length: 30,
    });
    expect(sc(last).page).toMatchObject({ returned: 11, total: 101, truncated: false });
    expect(sc(last).page.nextOffset).toBeNull();
    // HTTP と同じ版（本文全体の版）
    const http = (await (await app.request('/memory/values', { headers: OPERATOR })).json()) as {
      version: string;
    };
    expect(sc(first).version).toBe(http.version);
  });

  it('不正な slug は断り、無い記憶はツールエラー', async () => {
    const app = buildApp();
    const bad = await callTool(app, OPERATOR, 'memory_read', { slug: '../etc/passwd' });
    expect(bad.json.result?.isError === true || bad.json.error !== undefined).toBe(true);
    const missing = await callTool(app, OPERATOR, 'memory_read', { slug: 'nothing' });
    expect(missing.json.result?.isError).toBe(true);
  });

  it('頁の切れ目をまたぐ鍵は、切る前に走査するので頭も残らない', async () => {
    const app = buildApp();
    // 鍵の前後は空白（規則は語の境目で当たる）。切れ目が鍵の途中に落ちる offset を並べる
    await stores.persona.write('keys', `${'x'.repeat(39)} ${GITHUB} ${'y'.repeat(39)}`);
    for (const offset of [0, 20, 40, 50, 60]) {
      const result = await callTool(app, OPERATOR, 'memory_read', {
        slug: 'keys',
        offset,
        length: 30,
      });
      expect(result.text, `offset=${String(offset)}`).not.toContain('ghp_');
    }
    const whole = await callTool(app, OPERATOR, 'memory_read', { slug: 'keys', length: 200 });
    expect(sc(whole).document.content).toContain('[redacted:');
    expect(sc(whole).secretScan.hits.length).toBeGreaterThan(0);
    // 規則名と件数だけ（値・位置・文脈は無い）
    expect(Object.keys(sc(whole).secretScan.hits[0]).sort()).toEqual(['count', 'rule']);
  });
});

describe('読み取りの道具: 日誌・やり取り', () => {
  async function seed() {
    for (let i = 0; i < 25; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: i % 5 === 0 ? 'human' : 'manager',
        role: i % 2 === 0 ? 'outbound' : 'inbound',
        ...(i % 5 === 0 ? {} : { managerId: i % 2 === 0 ? 'mgr-a' : 'mgr-b' }),
        text: `発言${String(i)} ${'長'.repeat(1000)}`,
      });
    }
  }

  it('journal_read は limit 既定20・最大100、next で頁送り、長い欄は fieldChars で切る', async () => {
    const app = buildApp();
    await seed();
    const first = await callTool(app, OPERATOR, 'journal_read', {});
    expect(sc(first).entries).toHaveLength(20);
    expect(sc(first).next).not.toBeNull();
    expect(sc(first).fieldsTruncated).toBeGreaterThan(0);
    // 切らなければ 20 行 × 1000 字超 = 2 万字を優に超える
    expect(first.text.length).toBeLessThan(30_000);
    const second = await callTool(app, OPERATOR, 'journal_read', {
      afterId: sc(first).next.id,
      afterAt: sc(first).next.at,
    });
    expect(sc(second).entries).toHaveLength(5);
    expect(sc(second).next).toBeNull();

    const over = await callTool(app, OPERATOR, 'journal_read', { limit: 101 });
    expect(over.json.result?.isError === true || over.json.error !== undefined).toBe(true);
  });

  it('journal_read の type は未知の値を断る（HTTP と同じ文）', async () => {
    const app = buildApp();
    const result = await callTool(app, OPERATOR, 'journal_read', { type: 'exchange,nope' });
    expect(result.json.result?.isError).toBe(true);
    const http = (await (
      await app.request('/journal?type=exchange,nope', { headers: OPERATOR })
    ).json()) as {
      error: string;
    };
    expect(result.json.result?.content?.[0]?.text).toBe(http.error);
  });

  it('journal_read は HTTP の GET /journal と同じ並びの行を返す（長い欄を切らないとき）', async () => {
    const app = buildApp();
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: '短い' });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '返事',
    });
    const http = (await (
      await app.request('/journal?limit=20&order=asc&type=exchange', { headers: OPERATOR })
    ).json()) as { entries: unknown[]; next: unknown };
    const tool = await callTool(app, OPERATOR, 'journal_read', { order: 'asc', type: 'exchange' });
    expect(sc(tool).entries).toEqual(http.entries);
    expect(sc(tool).next).toEqual(http.next);
  });

  it('journal_read の id は1行を JSON の文字列で頁送りする。他の絞りとは併用できない', async () => {
    const app = buildApp();
    await seed();
    const entries = (await stores.journal.list({ limit: 1 })) as { id: string }[];
    const id = entries[0]!.id;
    const part = await callTool(app, OPERATOR, 'journal_read', { id, length: 100 });
    expect(sc(part).entryJson).toHaveLength(100);
    expect(sc(part).page.truncated).toBe(true);
    const both = await callTool(app, OPERATOR, 'journal_read', { id, q: 'x' });
    expect(both.json.result?.isError).toBe(true);
  });

  it('exchanges はクローン↔マネージャーの行だけを返す（人間との会話は含まない）。managerId で絞れ、本文は切って全長を返す', async () => {
    const app = buildApp();
    await seed();
    const all = await callTool(app, OPERATOR, 'exchanges', { limit: 100 });
    // 25 行のうち i%5===0（5行）が human
    expect(sc(all).exchanges).toHaveLength(20);
    expect(JSON.stringify(sc(all).exchanges)).not.toContain('"with"');
    const roles = new Set((sc(all).exchanges as { role: string }[]).map((row) => row.role));
    expect(roles).toEqual(new Set(['inbound', 'outbound']));
    const row = (sc(all).exchanges as Record<string, unknown>[])[0]!;
    expect(row.textTruncated).toBe(true);
    expect((row.text as string).length).toBeLessThan(600);
    expect(row.textChars).toBeGreaterThan(1000);

    const onlyA = await callTool(app, OPERATOR, 'exchanges', { managerId: 'mgr-a', limit: 100 });
    const rows = sc(onlyA).exchanges as { managerId: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.managerId === 'mgr-a')).toBe(true);
    // 絞りは取った頁の中。本文の接頭辞ではなく managerId の欄で見る（本文に `[mgr-a]` は無い）
    const narrow = await callTool(app, OPERATOR, 'exchanges', { managerId: 'mgr-a', limit: 2 });
    expect((sc(narrow).exchanges as unknown[]).length).toBeLessThanOrEqual(2);
    expect(sc(narrow).next).not.toBeNull();
  });

  it('exchanges に生ログ（transcript）の口は無い', async () => {
    const app = buildApp();
    const list = await rpc(app, OPERATOR, 'tools/list');
    const names = (list.json.result?.tools ?? []).map((tool) => tool.name);
    expect(names.filter((name) => name.includes('transcript'))).toEqual([]);
    const unknown = await callTool(app, OPERATOR, 'manager_transcript', {});
    expect(unknown.json.result?.isError === true || unknown.json.error !== undefined).toBe(true);
  });
});

describe('読み取りの道具: 利用状況・クローンのプロンプト', () => {
  async function seedUsage() {
    for (const [i, date] of ['2026-05-30', '2026-05-31', '2026-06-01'].entries()) {
      await stores.usage.record({
        layer: 'clone',
        site: 'session',
        accumulation: 'cumulative',
        managerId: 'clone',
        date,
        at: `${date}T10:00:00.000Z`,
        snapshot: {
          models: {
            'claude-opus-5': {
              inputTokens: 1 + i,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUsd: 1,
            },
          },
        },
      });
    }
  }

  it('usage_read は既定で集計だけ。rows / turnRows は includeRows: true のときだけ、頁送りで返る', async () => {
    const app = buildApp();
    await seedUsage();
    const plain = await callTool(app, OPERATOR, 'usage_read', {});
    expect(sc(plain).breakdown).toBeDefined();
    expect(sc(plain).rows).toBeUndefined();
    expect(sc(plain).turnRows).toBeUndefined();
    expect(sc(plain).rowsIncluded).toBe(false);
    expect(sc(plain).rowsTotal).toBeGreaterThan(0);

    const withRows = await callTool(app, OPERATOR, 'usage_read', {
      includeRows: true,
      rowsLimit: 1,
    });
    expect(sc(withRows).rows).toHaveLength(1);
    expect(sc(withRows).rowsNextOffset).toBe(1);

    // HTTP の集計と同じ値（`rows` を外した残り）
    const http = (await (await app.request('/usage', { headers: OPERATOR })).json()) as Record<
      string,
      unknown
    >;
    expect(sc(plain).breakdown).toEqual(http.breakdown);
    expect(sc(plain).today).toBe(http.today);
  });

  it('self_prompt は既定で大きさだけ（本文なし）。full: true は systemPrompt.text を頁送りし、道具は tool で1本ずつ', async () => {
    const app = buildApp();
    const small = await callTool(app, OPERATOR, 'self_prompt', {});
    expect(sc(small).full).toBe(false);
    expect(sc(small).systemPrompt).toEqual({ chars: 5010 });
    expect(sc(small).tools[0].description).toBeUndefined();

    const page1 = await callTool(app, OPERATOR, 'self_prompt', { full: true, length: 100 });
    expect(sc(page1).systemPrompt.text).toHaveLength(100);
    expect(sc(page1).page).toMatchObject({
      target: 'systemPrompt.text',
      returned: 100,
      truncated: true,
      nextOffset: 100,
    });
    expect(sc(page1).tools[0].description).toBeUndefined();
    expect(page1.text).not.toContain('ghp_');
    expect(
      sc(page1).secretScan.hits.some((hit: { rule: string }) => hit.rule.startsWith('github')),
    ).toBe(true);

    const tool = await callTool(app, OPERATOR, 'self_prompt', {
      full: true,
      tool: 'journal_read',
      field: 'inputSchema',
      length: 20,
    });
    expect(sc(tool).page.target).toBe('tools[journal_read].inputSchema');
    expect(sc(tool).tools[0].inputSchema).toHaveLength(20);
    expect(sc(tool).systemPrompt).toEqual({ chars: 5010 });
    const none = await callTool(app, OPERATOR, 'self_prompt', { full: true, tool: 'nope' });
    expect(none.json.result?.isError).toBe(true);
  });
});

describe('読み取りの道具: 走査の失敗は結果を返さない', () => {
  it('走査の器が作れず落ちたら、結果を返さずツールエラー。例外の文面は返さない', async () => {
    const poisoned = new Proxy({} as NodeJS.ProcessEnv, {
      ownKeys() {
        throw new Error('LEAK-例外の文面');
      },
    });
    const app = buildApp(poisoned);
    await stores.persona.write('values', 'SEEDMARK-記憶の本文');
    const result = await callTool(app, OPERATOR, 'memory_read', { slug: 'values' });
    expect(result.json.result?.isError).toBe(true);
    expect(result.json.result?.structuredContent).toBeUndefined();
    expect(result.text).not.toContain('SEEDMARK');
    expect(result.text).not.toContain('LEAK');
  });

  it('結果が上限を超えるなら、切らずに狭め方を言って断る', async () => {
    const app = buildApp();
    // 上限を超える結果は頁送りの上限では作れないので、大量の記憶の一覧で作る（1件のメタ情報が数百字）
    for (let i = 0; i < 700; i += 1) {
      await stores.persona.write(`doc-${String(i)}`, 'x'.repeat(10));
    }
    const result = await callTool(app, OPERATOR, 'memory_list');
    expect(result.json.result?.isError).toBe(true);
    expect(result.json.result?.structuredContent).toBeUndefined();
    expect(result.json.result?.content?.[0]?.text).toContain('大きすぎる');
  });
});

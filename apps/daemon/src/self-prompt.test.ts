import {
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
  fakeCloneHost,
} from '@alteroid/core';
import type { ClonePromptSnapshot, CloneHost, Stores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { SelfPromptBody } from './self-prompt.js';

// ダミーの鍵（どこの鍵でもない。繰り返しで作る）
const GITHUB = `ghp_${'a1B2'.repeat(9)}`;
const INTEGRATION = `altk_${'x9Y8'.repeat(8)}`;
const ANTHROPIC = `sk-ant-api03-${'Zz9_-'.repeat(8)}`;
const PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
  '-----END PRIVATE KEY-----',
].join('\n');
const ENV_VALUE = 'dummy-env-secret-value-0123456789';
const SECRETS = [
  GITHUB,
  INTEGRATION,
  ANTHROPIC,
  'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
  ENV_VALUE,
];

const AUTH = { authorization: 'Bearer test-token' };

let stores: Stores;
beforeEach(() => {
  stores = createMemoryStores();
});

function cloneHost(snapshot: ClonePromptSnapshot): CloneHost {
  return fakeCloneHost({
    promptSnapshot: () => snapshot,
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
  });
}

function build(
  snapshot: ClonePromptSnapshot,
  env: NodeJS.ProcessEnv = { ALTEROID_TEST_SECRET: ENV_VALUE },
) {
  return createApp({
    clone: cloneHost(snapshot),
    stores,
    token: 'test-token',
    shutdown: () => {},
    env,
  });
}

async function get(app: ReturnType<typeof build>, path = '/self/prompt') {
  const response = await app.request(path, { headers: AUTH });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as SelfPromptBody };
}

const usageOf = (overrides: Record<string, unknown> = {}) =>
  ({
    ok: true,
    at: '2026-11-15T00:00:05.000Z',
    totalTokens: 1000,
    rawMaxTokens: 200_000,
    percentage: 0.5,
    autoCompactThreshold: null,
    isAutoCompactEnabled: true,
    categories: {
      available: true,
      value: { rows: [{ name: 'System prompt', tokens: 10, kind: 'used' }], omitted: 0 },
    },
    mcpTools: {
      available: true,
      value: {
        rows: [{ name: 'journal_read', serverName: 'alteroid', tokens: 20, isLoaded: true }],
        omitted: 0,
      },
    },
    systemPromptSections: { available: true, value: { rows: [], omitted: 0 } },
    memoryFiles: {
      available: true,
      value: { rows: [{ path: '/data/memory/values.md', type: 'Project', tokens: 5 }], omitted: 0 },
    },
    systemTools: {
      available: true,
      value: {
        rows: [
          { name: 'Bash', tokens: 120 },
          { name: 'Read', tokens: 80 },
        ],
        omitted: 0,
      },
    },
    deferredBuiltinTools: {
      available: true,
      value: { rows: [{ name: 'WebFetch', tokens: 30, isLoaded: false }], omitted: 0 },
    },
    mcpInstructions: { available: false, reason: 'この欄が無かった' },
    messageBreakdown: { available: false, reason: 'この欄が無かった' },
    ...overrides,
  }) as ClonePromptSnapshot['contextUsage'];

const sessionOf = (overrides: Record<string, unknown> = {}) =>
  ({
    ok: true,
    builtAt: '2026-11-15T00:00:00.000Z',
    resumedFrom: null,
    sessionId: 'sess-1',
    model: 'opus',
    systemPrompt: { text: 'あなたはクローンである。通常の文章はそのまま出る。', chars: 24 },
    memoryInPrompt: {
      documents: [
        {
          slug: 'values',
          type: 'premise',
          description: '価値観の要旨',
          chars: 900,
          index: { kind: 'baked', form: 'premise-card', chars: 210 },
        },
        {
          slug: 'old-note',
          type: 'fact',
          description: null,
          chars: 50,
          index: { kind: 'omitted', reason: 'fact の目次から省かれた（件数の上限に当たった）' },
        },
      ],
      omitted: 0,
    },
    tools: [
      {
        name: 'journal_read',
        description: '日誌を読む',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: '行の id' } },
        },
        descriptionChars: 5,
        inputSchemaChars: 80,
      },
    ],
    builtinTools: {
      available: false,
      reason: '組み込みの道具の定義は取れない（SDK の型に口が無い）',
    },
    externalMcpServers: [
      { name: 'github', type: 'stdio' },
      { name: 'remote', type: 'http' },
    ],
    externalMcpServersLive: null,
    plugins: [{ name: 'alpha' }],
    ...overrides,
  }) as ClonePromptSnapshot['session'];

const snapshotOf = (
  session: ClonePromptSnapshot['session'] = sessionOf(),
  contextUsage: ClonePromptSnapshot['contextUsage'] = usageOf(),
): ClonePromptSnapshot => ({ session, contextUsage });

describe('GET /self/prompt — 形', () => {
  it('全文・道具の説明・入力スキーマ・索引の長さ・外部 MCP の名前と種別を返す', async () => {
    const { status, json } = await get(build(snapshotOf()));
    expect(status).toBe(200);
    const body = json();
    expect(body.full).toBe(true);
    expect(body.session).toEqual({
      ok: true,
      builtAt: '2026-11-15T00:00:00.000Z',
      resumedFrom: null,
      sessionId: 'sess-1',
      model: 'opus',
    });
    expect(body.systemPrompt).toEqual({
      text: 'あなたはクローンである。通常の文章はそのまま出る。',
      chars: 24,
    });
    expect(body.memoryInPrompt?.documents).toEqual([
      {
        slug: 'values',
        type: 'premise',
        description: '価値観の要旨',
        chars: 900,
        indexChars: 210,
        indexForm: 'premise-card',
        omitted: false,
        indexNote: null,
      },
      {
        slug: 'old-note',
        type: 'fact',
        description: null,
        chars: 50,
        indexChars: null,
        indexForm: null,
        omitted: true,
        indexNote: 'fact の目次から省かれた（件数の上限に当たった）',
      },
    ]);
    expect(body.memoryInPrompt?.omittedDocuments).toBe(0);
    expect(body.tools).toEqual([
      {
        name: 'journal_read',
        source: 'clone',
        description: '日誌を読む',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: '行の id' } },
        },
        descriptionChars: 5,
        inputSchemaChars: 80,
      },
    ]);
    expect(body.externalMcpServers).toEqual([
      { name: 'github', type: 'stdio' },
      { name: 'remote', type: 'http' },
    ]);
    expect(body.externalMcpServersLive).toBeNull();
    expect(body.plugins).toEqual([{ name: 'alpha' }]);
    expect(body.contextUsage?.ok).toBe(true);
  });

  it('組み込みの道具は「取れない」と理由を言い、名前と大きさは文脈占有から載せる', async () => {
    const body = (await get(build(snapshotOf()))).json();
    expect(body.builtinTools).toEqual({
      available: false,
      reason: expect.stringContaining('取れない'),
      systemTools: {
        available: true,
        value: {
          rows: [
            { name: 'Bash', tokens: 120 },
            { name: 'Read', tokens: 80 },
          ],
          omitted: 0,
        },
      },
      deferredBuiltinTools: {
        available: true,
        value: { rows: [{ name: 'WebFetch', tokens: 30, isLoaded: false }], omitted: 0 },
      },
    });
  });

  it('ターン境界をまだ観測していなければ、builtinTools の大きさは null で、理由を notice に書く（0 を置かない）', async () => {
    const body = (await get(build(snapshotOf(sessionOf(), null)))).json();
    expect(body.contextUsage).toBeNull();
    expect(body.builtinTools?.systemTools).toBeNull();
    expect(body.builtinTools?.deferredBuiltinTools).toBeNull();
    expect(body.notice.some((line) => line.includes('ターン境界をまだ観測していない'))).toBe(true);
  });

  it('文脈占有の取得に失敗した回は理由つきの値を返し、notice にも書く', async () => {
    const failed = { ok: false, at: '2026-11-15T00:00:09.000Z', error: '時間切れ' } as const;
    const body = (await get(build(snapshotOf(sessionOf(), failed)))).json();
    expect(body.contextUsage).toEqual(failed);
    expect(body.notice.some((line) => line.includes('文脈占有の取得に失敗'))).toBe(true);
  });

  it('スナップショットが未取得なら session は null で、他の軸は空配列ではなく null（理由は notice）', async () => {
    const body = (await get(build(snapshotOf(null, null)))).json();
    expect(body.session).toBeNull();
    for (const key of [
      'systemPrompt',
      'memoryInPrompt',
      'tools',
      'builtinTools',
      'externalMcpServers',
      'plugins',
    ] as const) {
      expect(body[key], key).toBeNull();
    }
    expect(body.notice[0]).toContain('まだセッションが組まれていない');
  });

  it('組み立て失敗の回は {ok:false, at, error} をそのまま返す', async () => {
    const failure = {
      ok: false,
      at: '2026-11-15T00:00:00.000Z',
      error: '道具を組めなかった',
    } as const;
    const body = (await get(build(snapshotOf(failure, null)))).json();
    expect(body.session).toEqual(failure);
    expect(body.tools).toBeNull();
    expect(body.notice[0]).toContain('組めなかった回');
  });

  it('記憶の文書を件数の上限で切り捨てたら、切り捨てた件数を値で返し notice にも書く（黙って切らない）', async () => {
    const session = sessionOf({
      memoryInPrompt: { documents: [], omitted: 7 },
    });
    const body = (await get(build(snapshotOf(session)))).json();
    expect(body.memoryInPrompt?.omittedDocuments).toBe(7);
    expect(body.notice.some((line) => line.includes('7 件'))).toBe(true);
  });

  it('索引の長さを取れなかった文書は indexChars が null で、理由を言う（0 を置かない）', async () => {
    const session = sessionOf({
      memoryInPrompt: {
        documents: [
          {
            slug: 'x',
            type: 'premise',
            description: null,
            chars: 3,
            index: { kind: 'unavailable', reason: '控えに無かった' },
          },
        ],
        omitted: 0,
      },
    });
    const body = (await get(build(snapshotOf(session)))).json();
    expect(body.memoryInPrompt?.documents[0]).toMatchObject({
      indexChars: null,
      omitted: false,
      indexNote: '控えに無かった',
    });
  });
});

describe('GET /self/prompt — full', () => {
  it('full=0 は本文・道具の説明・入力スキーマを省き、大きさは残し、省いたことを notice に言う', async () => {
    const { status, text, json } = await get(build(snapshotOf()), '/self/prompt?full=0');
    expect(status).toBe(200);
    const body = json();
    expect(body.full).toBe(false);
    expect(body.systemPrompt).toEqual({ chars: 24 });
    expect(body.tools).toEqual([
      { name: 'journal_read', source: 'clone', descriptionChars: 5, inputSchemaChars: 80 },
    ]);
    expect(text).not.toContain('通常の文章はそのまま出る');
    expect(text).not.toContain('日誌を読む');
    expect(body.notice.some((line) => line.includes('full=0'))).toBe(true);
    // 索引の長さは full に関わらず残る
    expect(body.memoryInPrompt?.documents[0]?.indexChars).toBe(210);
  });

  it('full=1 は既定と同じ', async () => {
    const app = build(snapshotOf());
    const explicit = (await get(app, '/self/prompt?full=1')).json();
    const fallback = (await get(app)).json();
    expect(explicit).toEqual(fallback);
  });

  for (const bad of ['2', 'true', 'false', '', '01', 'yes']) {
    it(`full=${bad === '' ? '（空）' : bad} は 400（黙って既定にしない）で、入力値を返さない`, async () => {
      const { status, text } = await get(build(snapshotOf()), `/self/prompt?full=${bad}`);
      expect(status).toBe(400);
      expect(text).toContain('full は 1 か 0');
      expect(text).not.toContain('通常の文章');
      if (bad !== '') expect(text).not.toContain(`=${bad}`);
    });
  }
});

describe('GET /self/prompt — 秘密走査', () => {
  const dirtySession = () =>
    sessionOf({
      systemPrompt: {
        text: `通常の文章。鍵 ${GITHUB} と ${PEM} と環境の値 ${ENV_VALUE}。`,
        chars: 100,
      },
      memoryInPrompt: {
        documents: [
          {
            slug: 'values',
            type: 'premise',
            description: `要旨に ${INTEGRATION} が混ざった`,
            chars: 10,
            index: { kind: 'baked', form: 'premise-card', chars: 5 },
          },
        ],
        omitted: 0,
      },
      tools: [
        {
          name: 'tool_x',
          description: `説明に ${ANTHROPIC}`,
          inputSchema: {
            type: 'object',
            properties: { key: { type: 'string', description: `例: ${GITHUB}` } },
          },
          descriptionChars: 10,
          inputSchemaChars: 10,
        },
      ],
      externalMcpServers: [{ name: `srv-${GITHUB}`, type: 'stdio' }],
    });
  const dirtyUsage = () =>
    usageOf({
      mcpTools: {
        available: true,
        value: {
          rows: [
            { name: `tool-${INTEGRATION}`, serverName: 'alteroid', tokens: 1, isLoaded: true },
          ],
          omitted: 0,
        },
      },
      memoryFiles: {
        available: true,
        value: {
          rows: [{ path: `/data/${ENV_VALUE}/values.md`, type: null, tokens: 5 }],
          omitted: 0,
        },
      },
    });

  it('応答のどこにもダミーの鍵・PEM・環境変数の値が含まれず、[redacted:…] が入り、通常の文章は壊れない', async () => {
    const { status, text } = await get(build(snapshotOf(dirtySession(), dirtyUsage())));
    expect(status).toBe(200);
    for (const secret of SECRETS) expect(text, secret.slice(0, 8)).not.toContain(secret);
    expect(text).toContain('[redacted:github-token]');
    expect(text).toContain('[redacted:integration-key]');
    expect(text).toContain('[redacted:anthropic-key]');
    expect(text).toContain('[redacted:private-key-pem]');
    expect(text).toContain('[redacted:env:ALTEROID_TEST_SECRET]');
    expect(text).toContain('通常の文章。鍵 ');
  });

  it('notice と secretScan に、当たった規則の名前と件数だけが出る（値・位置・文脈は無い）', async () => {
    const body = (await get(build(snapshotOf(dirtySession(), dirtyUsage())))).json();
    const scanLine = body.notice[body.notice.length - 1] as string;
    expect(scanLine.startsWith('秘密走査: ')).toBe(true);
    expect(scanLine).toMatch(/github-token \d+ 件/);
    expect(scanLine).toMatch(/env:ALTEROID_TEST_SECRET 2 件/);
    expect(scanLine).toContain('を伏せた');
    for (const secret of SECRETS) expect(JSON.stringify(body.notice)).not.toContain(secret);
    expect(body.secretScan.scanned).toBe(true);
    const byRule = Object.fromEntries(body.secretScan.hits.map((hit) => [hit.rule, hit.count]));
    expect(byRule['github-token']).toBe(3);
    expect(byRule['integration-key']).toBe(2);
    expect(byRule['anthropic-key']).toBe(1);
    expect(byRule['private-key-pem']).toBe(1);
    expect(byRule['env:ALTEROID_TEST_SECRET']).toBe(2);
    expect(JSON.stringify(body.secretScan)).not.toMatch(/ghp_|altk_|sk-ant|BEGIN/);
  });

  it('組み立て失敗の回のエラー文も走査を通る', async () => {
    const failure = {
      ok: false,
      at: '2026-11-15T00:00:00.000Z',
      error: `接続に失敗 ${GITHUB}`,
    } as const;
    const { text, json } = await get(
      build(snapshotOf(failure, { ok: false, at: 'x', error: `別の失敗 ${INTEGRATION}` })),
    );
    expect(text).not.toContain(GITHUB);
    expect(text).not.toContain(INTEGRATION);
    expect(json().session).toEqual({
      ok: false,
      at: '2026-11-15T00:00:00.000Z',
      error: '接続に失敗 [redacted:github-token]',
    });
  });

  it('当たりが無かったときは「走査した（当たり0件）」を出す（走査していないこととは区別する）', async () => {
    const body = (await get(build(snapshotOf()))).json();
    expect(body.notice[body.notice.length - 1]).toBe('秘密走査: 走査した（当たり0件）');
    expect(body.secretScan).toEqual({ scanned: true, hits: [] });
  });

  it('full=0 でも走査は掛かる（大きさだけの応答にも秘密は載らない）', async () => {
    const { text } = await get(
      build(snapshotOf(dirtySession(), dirtyUsage())),
      '/self/prompt?full=0',
    );
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).toContain('[redacted:');
  });

  it('外部 MCP の登録（env・headers に既知のダミー値）が器にあっても、応答のどこにも出ない', async () => {
    await stores.mcpServers.write({
      local: { command: 'node', args: [`--token=${ENV_VALUE}`], env: { API_KEY: ENV_VALUE } },
      remote: {
        type: 'http',
        url: 'https://example.invalid/x',
        headers: { Authorization: `Bearer ${ENV_VALUE}` },
      },
    });
    const { text } = await get(build(snapshotOf()));
    expect(text).not.toContain(ENV_VALUE);
    expect(text).not.toContain('example.invalid');
    expect(text).not.toContain('API_KEY');
  });

  it('走査が例外で落ちたら 500 で、システムプロンプトも秘密も返さない', async () => {
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      ownKeys: () => {
        throw new Error(`走査の準備で落ちた ${GITHUB}`);
      },
    });
    const { status, text } = await get(build(snapshotOf(dirtySession(), dirtyUsage()), env));
    expect(status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: expect.stringContaining('応答を返さない') });
    expect(text).not.toContain('通常の文章');
    expect(text).not.toContain(GITHUB);
    expect(text).not.toContain('走査の準備で落ちた');
  });
});

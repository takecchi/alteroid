import type { CloneHost, DiagnosticsSummary, InboxEvent, Stores } from '@alteroid/core';
import {
  buildDiagnosticsSummary,
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  createMemoryStores,
  fakeCloneHost,
  jsonByteLength,
  parseJournalJsonl,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const OPERATOR = { authorization: 'Bearer test-token' };
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const T0 = Date.parse('2026-11-14T00:00:00.000Z');

let stores: Stores;
let posted: InboxEvent[] = [];

function buildApp(overrideStores?: Stores) {
  const clone = fakeCloneHost({
    post: (event: InboxEvent) => {
      posted.push(event);
      return 'conversation-1';
    },
    postPersisted: async (event: InboxEvent) => {
      posted.push(event);
      return 'persisted' as const;
    },
    subscribe: () => () => undefined,
    stop: () => Promise.resolve(),
    usageBlocked: false,
    managers: {
      list: () => Promise.resolve([]),
      listWithUnreadable: () => Promise.resolve({ managers: [], unreadable: [] }),
    },
  } as unknown as Partial<CloneHost>);
  return createApp({
    clone,
    stores: overrideStores ?? stores,
    token: 'test-token',
    shutdown: () => undefined,
    now: () => new Date(T0),
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

async function issue(app: App, input: Record<string, unknown> = {}) {
  const response = await app.request('/integration-keys', {
    method: 'POST',
    headers: { ...OPERATOR, 'content-type': 'application/json' },
    body: JSON.stringify({ name: '診断の鍵', source: 'remote.alteroid', ...input }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { key: { id: string }; value: string };
  return { id: body.key.id, value: body.value };
}

const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

interface RpcResult {
  status: number;
  json: {
    result?: {
      tools?: { name: string }[];
      isError?: boolean;
      content?: { text: string }[];
      structuredContent?: { ok: boolean; id: string; duplicate: boolean };
    };
    error?: { message: string };
  };
}

async function rpc(
  app: App,
  headers: Record<string, string>,
  method: string,
  params?: unknown,
): Promise<RpcResult> {
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
    json: text === '' ? {} : (JSON.parse(text) as RpcResult['json']),
  };
}

const send = (app: App, headers: Record<string, string>, summary: unknown) =>
  rpc(app, headers, 'tools/call', {
    name: 'report_diagnostics_summary',
    arguments: { summary },
  });

function turnUsage(at: string, managerId = 'mgr-a') {
  return {
    type: 'turn_usage',
    id: `u-${at}`,
    at,
    layer: 'clone',
    site: 'session',
    managerId,
    models: {
      opus: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 100,
        webSearchRequests: 0,
        costUsd: 0.1,
      },
    },
  };
}

function makeSummary(day = '01', rows?: unknown[]): DiagnosticsSummary {
  const lines = rows ?? [
    turnUsage(`2026-11-${day}T00:00:00.000Z`),
    turnUsage(`2026-11-${day}T06:00:00.000Z`),
  ];
  return buildDiagnosticsSummary(
    { journal: parseJournalJsonl(lines.map((r) => JSON.stringify(r)).join('\n')) },
    { now: new Date('2026-11-10T00:00:00.000Z') },
  );
}

/** 型の上限いっぱいに膨らませて、16 KiB を超える（型は通る形の）要約を作る */
function oversizedSummary(): unknown {
  const base = structuredClone(makeSummary()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const longId = 'm'.repeat(80);
  const size = { median: 1, max: 1, missingRows: 0 };
  base.promptSize.days = Array.from({ length: 31 }, (_, i) => ({
    day: `2026-10-${String(i + 1).padStart(2, '0')}`,
    rows: 1,
    systemPromptTokens: size,
    memoryFileTokens: size,
    mcpToolTokens: size,
    totalTokens: size,
  }));
  base.perTurn.topManagers.rows = Array.from({ length: 20 }, () => ({
    managerId: longId,
    layer: 'clone',
    turns: 1,
    cacheRead: 1,
  }));
  base.resets.ledger = {
    state: 'known',
    baselines: 1,
    total: 1,
    rows: Array.from({ length: 20 }, () => ({
      layer: 'clone',
      managerId: longId,
      resets: 1,
      lastResetAt: null,
    })),
  };
  base.promptSize.mcpServers.rows = Array.from({ length: 5 }, () => ({
    name: 'n'.repeat(64),
    observations: 1,
    medianTokens: 1,
    maxTokens: 1,
  }));
  base.triggers.batchSize.distribution = Array.from({ length: 12 }, (_, i) => ({
    batchSize: i + 1,
    count: 1,
  }));
  // 数は桁を最大にする（`limit`・`schemaVersion` は範囲・リテラルがあるので触らない）
  const widen = (value: unknown): unknown => {
    if (typeof value === 'number') return 9007199254740991;
    if (Array.isArray(value)) return value.map(widen);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [
          key,
          key === 'limit' || key === 'schemaVersion' || key === 'day' ? inner : widen(inner),
        ]),
      );
    }
    return value;
  };
  return widen(base);
}

async function receivedRows() {
  return stores.journal.list({ types: ['diagnostics_summary'] });
}

beforeEach(() => {
  stores = createMemoryStores();
  posted = [];
});

describe('POST /mcp: tools/list', () => {
  it('道具は report_problem と report_diagnostics_summary の2本', async () => {
    const app = buildApp();
    const { value } = await issue(app);
    const list = await rpc(app, bearer(value), 'tools/list');
    expect(list.json.result?.tools?.map((t) => t.name).sort()).toEqual([
      'report_diagnostics_summary',
      'report_problem',
    ]);
  });
});

describe('POST /mcp: report_diagnostics_summary（受ける側）', () => {
  it('連携の鍵で送ると日誌に1行積まれ（source・keyId は鍵のもの）、受信箱には何も積まれずクローンも起きない', async () => {
    const app = buildApp();
    const { id: keyId, value } = await issue(app);
    const summary = makeSummary();
    const result = await send(app, bearer(value), summary);
    expect(result.json.result?.isError).toBeUndefined();
    const sc = result.json.result?.structuredContent;
    expect(sc).toEqual({ ok: true, id: expect.any(String), duplicate: false });

    const rows = await receivedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'diagnostics_summary',
      id: sc?.id,
      source: 'remote.alteroid',
      principalKind: 'integration',
      keyId,
      payload: summary,
    });
    // 受信箱へ積まない（クローンのターンを起こさない）。日誌の external_event も増えない
    expect(posted).toHaveLength(0);
    expect(await stores.journal.list({ types: ['external_event'] })).toHaveLength(0);
    expect(JSON.stringify(await stores.journal.list())).not.toContain(value);

    // 既存の口（GET /journal）で読める
    const read = await app.request('/journal?type=diagnostics_summary', { headers: OPERATOR });
    expect(read.status).toBe(200);
    const body = (await read.json()) as { entries: { id: string; source: string }[] };
    expect(body.entries.map((e) => [e.id, e.source])).toEqual([[sc?.id, 'remote.alteroid']]);
  });

  it('operator で送ると source は alteroid-report、keyId は付かない', async () => {
    const app = buildApp();
    const result = await send(app, OPERATOR, makeSummary());
    expect(result.json.result?.structuredContent?.ok).toBe(true);
    const rows = await receivedRows();
    expect(rows[0]).toMatchObject({ source: 'alteroid-report', principalKind: 'operator' });
    expect(rows[0]).not.toHaveProperty('keyId');
  });

  it('通らない要約は isError で、日誌に何も増えず、エラーに入力の値が出ない', async () => {
    const app = buildApp();
    const { value } = await issue(app);
    const valid = makeSummary() as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const secret = 'altk_0123456789abcdef0123456789abcdef0123456789abcdef';
    const anthropic = 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ';
    const body = 'これは依頼の本文のような長い文字列です。LEAKBODY '.repeat(5);
    const withManager = (managerId: string) => ({
      ...structuredClone(valid),
      perTurn: {
        ...structuredClone(valid.perTurn),
        topManagers: {
          ...structuredClone(valid.perTurn.topManagers),
          rows: [{ managerId, layer: 'clone', turns: 1, cacheRead: 1 }],
        },
      },
    });
    const cases: [string, unknown, string[]][] = [
      ['未知の欄', { ...structuredClone(valid), unknownField: 'LEAKUNKNOWN' }, ['LEAKUNKNOWN']],
      ['サイズ超過', oversizedSummary(), []],
      [
        '列挙外',
        {
          ...structuredClone(valid),
          cache: {
            ...structuredClone(valid.cache),
            fromTurnUsage: {
              ...structuredClone(valid.cache.fromTurnUsage),
              byLayer: [
                { layer: 'LEAKENUM', stat: structuredClone(valid.cache.fromTurnUsage.overall) },
              ],
            },
          },
        },
        ['LEAKENUM'],
      ],
      ['altk_ を含む managerId', withManager(secret), [secret, 'altk_']],
      ['sk-ant- を含む managerId', withManager(anthropic), [anthropic, 'sk-ant-']],
      ['本文のような長い文字列', withManager(body), ['LEAKBODY', '依頼の本文']],
    ];
    expect(jsonByteLength(oversizedSummary())).toBeGreaterThan(16 * 1024);
    for (const [label, summary, leaks] of cases) {
      const result = await send(app, bearer(value), summary);
      expect(result.json.result?.isError, label).toBe(true);
      const text = JSON.stringify(result.json);
      for (const leak of leaks) expect(text, label).not.toContain(leak);
      expect(await receivedRows(), label).toHaveLength(0);
    }
    expect(posted).toHaveLength(0);
    // 欄名と理由の種類は言う（サイズ超過・形の不一致）
    const oversize = await send(app, bearer(value), oversizedSummary());
    expect(oversize.json.result?.content?.[0]?.text).toContain('16384');
  });

  it('秘密走査は型の検査とは別に効く: 型に通る形（許可パターンの id）で秘密らしい塊が入った要約も積まない', async () => {
    const app = buildApp();
    const { value } = await issue(app);
    // 許可パターン（英数字と ._:-）に収まり、長い塊（hex 32 桁以上）として秘密走査に当たる managerId
    const hexLike = 'a1b2c3d4'.repeat(6);
    const valid = structuredClone(makeSummary()) as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    valid.perTurn.topManagers.rows = [
      { managerId: hexLike, layer: 'clone', turns: 1, cacheRead: 1 },
    ];
    const result = await send(app, bearer(value), valid);
    expect(result.json.result?.isError).toBe(true);
    expect(result.json.result?.content?.[0]?.text).toContain('秘密らしい');
    expect(JSON.stringify(result.json)).not.toContain(hexLike);
    expect(await receivedRows()).toHaveLength(0);
  });

  it('冪等: 同じ（source, period）の2回目は duplicate:true で積まれず、別の period・別の source は別に積む', async () => {
    const app = buildApp();
    const a = await issue(app, { name: 'a', source: 'env.a' });
    const b = await issue(app, { name: 'b', source: 'env.b' });
    const first = await send(app, bearer(a.value), makeSummary('01'));
    const again = await send(app, bearer(a.value), makeSummary('01'));
    expect(first.json.result?.structuredContent?.duplicate).toBe(false);
    expect(again.json.result?.structuredContent).toEqual({
      ok: true,
      id: first.json.result?.structuredContent?.id,
      duplicate: true,
    });
    expect(await receivedRows()).toHaveLength(1);
    expect(
      (await send(app, bearer(a.value), makeSummary('02'))).json.result?.structuredContent,
    ).toMatchObject({ duplicate: false });
    expect(
      (await send(app, bearer(b.value), makeSummary('01'))).json.result?.structuredContent,
    ).toMatchObject({ duplicate: false });
    expect(await receivedRows()).toHaveLength(3);
  });

  it('同時に2本届いても1件になる', async () => {
    const app = buildApp();
    const { value } = await issue(app);
    const results = await Promise.all([
      send(app, bearer(value), makeSummary('03')),
      send(app, bearer(value), makeSummary('03')),
    ]);
    const flags = results.map((r) => r.json.result?.structuredContent?.duplicate).sort();
    expect(flags).toEqual([false, true]);
    expect(await receivedRows()).toHaveLength(1);
  });

  it('日誌へ書けないときは isError で何も積まれず、送り直すと受け付けられる', async () => {
    let failing = true;
    const flaky: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: (entry) =>
          failing && entry.type === 'diagnostics_summary'
            ? Promise.reject(new Error('DISK-SECRET-DETAIL'))
            : stores.journal.append(entry),
      },
    };
    const app = buildApp(flaky);
    const { value } = await issue(app);
    const failed = await send(app, bearer(value), makeSummary());
    expect(failed.json.result?.isError).toBe(true);
    expect(failed.json.result?.content?.[0]?.text).toContain('送り直してよい');
    expect(JSON.stringify(failed.json)).not.toContain('DISK-SECRET-DETAIL');
    expect(await receivedRows()).toHaveLength(0);
    failing = false;
    const retried = await send(app, bearer(value), makeSummary());
    expect(retried.json.result?.structuredContent?.duplicate).toBe(false);
    expect(await receivedRows()).toHaveLength(1);
  });

  it('period が null（診断の行が1行も無い）の要約は断り、何も積まない', async () => {
    const app = buildApp();
    const { value } = await issue(app);
    const empty = buildDiagnosticsSummary(
      { journal: parseJournalJsonl('') },
      { now: new Date(T0) },
    );
    expect(empty.period).toBeNull();
    const result = await send(app, bearer(value), empty);
    expect(result.json.result?.isError).toBe(true);
    expect(result.json.result?.content?.[0]?.text).toContain('period が null');
    expect(await receivedRows()).toHaveLength(0);
  });

  it('鍵は GET /journal を引き続き読めず（403）、失効した鍵は 401 で何も積まれない', async () => {
    const app = buildApp();
    const { id, value } = await issue(app);
    await captureStderr(async () => {
      const read = await app.request('/journal?type=diagnostics_summary', {
        headers: bearer(value),
      });
      expect(read.status).toBe(403);
    });
    const revoke = await app.request(`/integration-keys/${id}/revoke`, {
      method: 'POST',
      headers: { ...OPERATOR, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(revoke.status).toBe(200);
    await captureStderr(async () => {
      const refused = await send(app, bearer(value), makeSummary());
      expect(refused.status).toBe(401);
    });
    expect(await receivedRows()).toHaveLength(0);
  });
});

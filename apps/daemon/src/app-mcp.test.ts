import type { CloneHost, InboxEvent, Stores } from '@alteroid/core';
import {
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  createMemoryStores,
  fakeCloneHost,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const OPERATOR = { authorization: 'Bearer test-token' };
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5]);

let nowMs = T0;
let stores: Stores;
let posted: InboxEvent[] = [];
let persistOutcome: 'persisted' | 'unavailable' = 'persisted';

function fakeClone(): CloneHost {
  return fakeCloneHost({
    post: (event: InboxEvent) => {
      posted.push(event);
      return 'conversation-1';
    },
    postPersisted: async (event: InboxEvent) => {
      if (persistOutcome === 'unavailable') return 'unavailable' as const;
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
}

function buildApp(enabled = true) {
  return createApp({
    clone: fakeClone(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    now: () => new Date(nowMs),
    journalEvents: { subscribe: () => () => undefined },
    auth: {
      plan: {
        enabled,
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
    body: JSON.stringify({ name: 'mcp の鍵', source: 'ext.ai', ...input }),
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

const report = (args: Record<string, unknown>) => ({
  name: 'report_problem',
  arguments: { summary: 'デーモンが落ちる', component: 'daemon', severity: 'high', ...args },
});

const call = (app: App, headers: Record<string, string>, args: Record<string, unknown> = {}) =>
  rpc(app, headers, 'tools/call', report(args));

beforeEach(() => {
  nowMs = T0;
  stores = createMemoryStores();
  posted = [];
  persistOutcome = 'persisted';
});

describe('POST /mcp: 道具は report_problem と report_diagnostics_summary の2本だけ', () => {
  it('initialize と tools/list: 道具は2本。未知の道具の tools/call と他の能力（資源・プロンプト）は拒否', async () => {
    const app = buildApp();
    const { value } = await issue(app);
    const h = bearer(value);
    const init = await rpc(app, h, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    });
    expect(init.status).toBe(200);
    expect(init.json.result).toBeDefined();
    expect(JSON.stringify(init.json.result)).not.toContain(value);

    const list = await rpc(app, h, 'tools/list');
    expect(list.json.result?.tools?.map((t) => t.name)).toEqual([
      'report_problem',
      'report_diagnostics_summary',
    ]);
    expect((await rpc(app, h, 'ping')).status).toBe(200);

    const unknown = await rpc(app, h, 'tools/call', { name: 'list_inbox', arguments: {} });
    expect(unknown.json.result?.isError === true || unknown.json.error !== undefined).toBe(true);
    for (const method of ['resources/list', 'prompts/list', 'resources/read', 'logging/setLevel']) {
      const refused = await rpc(app, h, method, {});
      expect(refused.json.error, method).toBeDefined();
      expect(refused.json.result, method).toBeUndefined();
    }
    expect(posted).toHaveLength(0);
  });

  it('GET /mcp は鍵では 403、持続接続は無い', async () => {
    const app = buildApp();
    const { value } = await issue(app);
    await captureStderr(async () => {
      const response = await app.request('/mcp', {
        headers: { ...bearer(value), accept: 'text/event-stream' },
      });
      expect(response.status).toBe(403);
    });
  });
});

describe('POST /mcp: report_problem', () => {
  it('受け付けると {ok,id,duplicate:false} だけ返し、受信箱には鍵の source・欄そのままの payload が積まれる', async () => {
    const app = buildApp();
    const { id: keyId, value } = await issue(app, { source: 'ext.ai' });
    const result = await call(app, bearer(value), { expected: 'e', logs: 'l' });
    expect(result.json.result?.isError).toBeUndefined();
    const sc = result.json.result?.structuredContent;
    expect(sc).toEqual({ ok: true, id: expect.any(String), duplicate: false });
    expect(JSON.parse(result.json.result?.content?.[0]?.text ?? '{}')).toEqual(sc);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: 'external',
      id: sc?.id,
      source: 'ext.ai',
      via: { keyId },
      payload: {
        summary: 'デーモンが落ちる',
        component: 'daemon',
        severity: 'high',
        expected: 'e',
        logs: 'l',
      },
    });
    expect(Object.keys((posted[0] as { payload: object }).payload).sort()).toEqual([
      'component',
      'expected',
      'logs',
      'severity',
      'summary',
    ]);
    expect(JSON.stringify(await stores.journal.list())).not.toContain(value);
  });

  it('source は引数に無い: 渡すと未知の欄として拒否され、何も積まれない', async () => {
    const app = buildApp();
    const { value } = await issue(app, { source: 'ext.ai' });
    const result = await call(app, bearer(value), { source: 'someone.else' });
    expect(result.json.result?.isError === true || result.json.error !== undefined).toBe(true);
    expect(posted).toHaveLength(0);
    await call(app, bearer(value));
    expect(posted.map((e) => (e as { source: string }).source)).toEqual(['ext.ai']);
  });

  it('operator・アカウントの資格で呼ぶと source は alteroid-report で、via は付かない', async () => {
    const app = buildApp();
    const result = await call(app, OPERATOR);
    expect(result.json.result?.structuredContent?.ok).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ source: 'alteroid-report' });
    expect(posted[0]).not.toHaveProperty('via');
  });

  it('同じ鍵の同じ報告（空白・大文字小文字の揺れは同じ）は2件目が duplicate:true で1件しか積まれない。別の component・別の鍵は束ねない', async () => {
    const app = buildApp();
    const a = await issue(app, { name: 'a', source: 'ext.ai' });
    const b = await issue(app, { name: 'b', source: 'ext.ai' });
    const first = await call(app, bearer(a.value), { summary: 'Daemon  falls over' });
    const second = await call(app, bearer(a.value), {
      summary: '  daemon falls\tOVER ',
      severity: 'low',
    });
    expect(first.json.result?.structuredContent?.duplicate).toBe(false);
    expect(second.json.result?.structuredContent).toEqual({
      ok: true,
      id: first.json.result?.structuredContent?.id,
      duplicate: true,
    });
    expect(posted).toHaveLength(1);
    const otherComponent = await call(app, bearer(a.value), {
      summary: 'daemon falls over',
      component: 'web',
    });
    expect(otherComponent.json.result?.structuredContent?.duplicate).toBe(false);
    const otherKey = await call(app, bearer(b.value), { summary: 'daemon falls over' });
    expect(otherKey.json.result?.structuredContent?.duplicate).toBe(false);
    expect(posted).toHaveLength(3);
  });

  it('永続化できないとき（unavailable）は isError で、何も積まれず、送り直すと受け付けられる', async () => {
    const app = buildApp();
    const { id: keyId, value } = await issue(app);
    const meta = await stores.attachments.put({
      name: 'a.png',
      mediaType: 'image/png',
      bytes: PNG,
      uploadedBy: `integration:${keyId}`,
    });
    persistOutcome = 'unavailable';
    const failed = await call(app, bearer(value), { attachmentIds: [meta.id] });
    expect(failed.json.result?.isError).toBe(true);
    expect(failed.json.result?.content?.[0]?.text).toContain('送り直してよい');
    expect(posted).toHaveLength(0);
    expect((await stores.attachments.getMeta(meta.id))?.externalEventId).toBeUndefined();
    persistOutcome = 'persisted';
    const retried = await call(app, bearer(value), { attachmentIds: [meta.id] });
    expect(retried.json.result?.structuredContent?.duplicate).toBe(false);
    expect(posted).toHaveLength(1);
  });

  it('添付: 同じ鍵が上げたものは付き、他の鍵・他の資格が上げたものは isError で何も積まれず結ばれない', async () => {
    const app = buildApp();
    const mine = await issue(app, { name: 'mine' });
    const other = await issue(app, { name: 'other' });
    const own = await stores.attachments.put({
      name: 'a.png',
      mediaType: 'image/png',
      bytes: PNG,
      uploadedBy: `integration:${mine.id}`,
    });
    const foreign = await stores.attachments.put({
      name: 'b.png',
      mediaType: 'image/png',
      bytes: PNG,
      uploadedBy: `integration:${other.id}`,
    });
    const refused = await call(app, bearer(mine.value), { attachmentIds: [foreign.id] });
    expect(refused.json.result?.isError).toBe(true);
    expect(posted).toHaveLength(0);
    expect((await stores.attachments.getMeta(foreign.id))?.externalEventId).toBeUndefined();
    const ok = await call(app, bearer(mine.value), { attachmentIds: [own.id] });
    expect(ok.json.result?.structuredContent?.ok).toBe(true);
    const event = posted[0] as { attachments?: { id: string }[] };
    expect(event.attachments?.map((ref) => ref.id)).toEqual([own.id]);
  });

  it('入力の検査: 上限超過・列挙外・欠落・NUL・未知の欄・添付6個は拒否され、何も積まれない', async () => {
    const app = buildApp();
    const { value } = await issue(app);
    for (const bad of [
      { summary: '' },
      { summary: 'x'.repeat(201) },
      { component: 'kernel' },
      { severity: 'critical' },
      { expected: 'x'.repeat(4001) },
      { actual: 'x'.repeat(4001) },
      { steps: 'x'.repeat(4001) },
      { environment: 'x'.repeat(1001) },
      { logs: 'x'.repeat(8001) },
      { summary: 'a\u0000b' },
      { logs: 'a\u0000b' },
      { priority: 'p0' },
      { attachmentIds: ['1', '2', '3', '4', '5', '6'] },
    ]) {
      const result = await call(app, bearer(value), bad);
      expect(
        result.json.result?.isError === true || result.json.error !== undefined,
        JSON.stringify(bad).slice(0, 40),
      ).toBe(true);
    }
    for (const missing of ['summary', 'component', 'severity']) {
      const args: Record<string, unknown> = { ...report({}).arguments };
      delete args[missing];
      const result = await rpc(app, bearer(value), 'tools/call', {
        name: 'report_problem',
        arguments: args,
      });
      expect(result.json.result?.isError === true || result.json.error !== undefined).toBe(true);
    }
    expect(posted).toHaveLength(0);
    // 上限ちょうどは通る
    const edge = await call(app, bearer(value), {
      summary: 'x'.repeat(200),
      logs: 'x'.repeat(8000),
      expected: 'x'.repeat(4000),
      environment: 'x'.repeat(1000),
    });
    expect(edge.json.result?.structuredContent?.ok).toBe(true);
  });
});

describe('POST /mcp: 門', () => {
  it('鍵なし（認証が有効）・未知・失効・期限切れの鍵は 401。何も積まれない', async () => {
    const app = buildApp();
    const revoked = await issue(app, { name: 'revoked' });
    const expiring = await issue(app, {
      name: 'expiring',
      expiresAt: new Date(T0 + 60_000).toISOString(),
    });
    await app.request(`/integration-keys/${revoked.id}/revoke`, {
      method: 'POST',
      headers: { ...OPERATOR, 'content-type': 'application/json' },
      body: '{}',
    });
    const journalBefore = (await stores.journal.list()).length;
    nowMs = T0 + 120_000;
    await captureStderr(async () => {
      expect((await call(app, {})).status).toBe(401);
      expect((await call(app, bearer('altk_unknown'))).status).toBe(401);
      expect((await call(app, bearer(revoked.value))).status).toBe(401);
      expect((await call(app, bearer(expiring.value))).status).toBe(401);
    });
    expect(posted).toHaveLength(0);
    expect(await stores.journal.list()).toHaveLength(journalBefore);
  });

  it('鍵の本文上限が効く（413）。断った試みは stderr へ書かれ、鍵の値は出ない', async () => {
    const app = buildApp();
    const { value } = await issue(app, { maxBodyBytes: 2000 });
    const lines = await captureStderr(async () => {
      expect((await call(app, bearer(value), { logs: 'x'.repeat(5000) })).status).toBe(413);
    });
    expect(lines.join('')).not.toContain(value);
    expect(posted).toHaveLength(0);
  });
});

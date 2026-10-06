/**
 * 添付の HTTP 口（`POST /attachments` / `GET /attachments/:id` / `POST /chat` の `attachments`。
 * Issue #3111 段1b）。**本物の `createClone`（偽 SDK のみ差し替え）と本物の `createApp`** を組み、
 * 「上げる → 送る → クローンのターンに image ブロックが届く」を端から端まで確かめる。
 */
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ALWAYS_REDELIVER,
  createAuthProviderRegistry,
  createAuthService,
  createClone,
  createLocalRunner,
  createMemoryStores,
  createRunnerRegistry,
  DEFAULT_ATTACHMENT_LIMITS,
  type CloneHost,
  type Stores,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

/** 本物の PNG のマジックバイト + 余り。 */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5]);
const PNG_BASE64 = Buffer.from(PNG).toString('base64');

/** 入力ごとの生の content を `blocks` に控える偽 SDK（`clone-test-harness.ts` の `inputBlocks` と同じ観測）。 */
function recordingSdk(blocks: unknown[]): typeof import('@anthropic-ai/claude-agent-sdk').query {
  return ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 's',
        uuid: 'u-init',
        model: 'claude-fake',
        claude_code_version: '9.9.9',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [],
      } as unknown as SDKMessage;
      const prompt = params.prompt;
      if (typeof prompt === 'string') return;
      let n = 0;
      for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
        blocks.push(message.message.content);
        n += 1;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '見た' }] },
          parent_tool_use_id: null,
          session_id: 's',
          uuid: `u-a-${n}`,
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: '見た',
          session_id: 's',
          uuid: `u-r-${n}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query;
}

function setupApp(options: { limits?: typeof DEFAULT_ATTACHMENT_LIMITS } = {}) {
  const stores = createMemoryStores();
  const blocks: unknown[] = [];
  const queryFn = recordingSdk(blocks);
  const clone = createClone({
    stores,
    queryFn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  const app = createApp({
    clone,
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    ...(options.limits === undefined ? {} : { attachmentLimits: options.limits }),
  });
  return { app, stores, clone, blocks };
}

const upload = (
  app: ReturnType<typeof createApp>,
  body: Uint8Array,
  query = 'name=shot.png&type=image%2Fpng',
  contentType = 'application/octet-stream',
) =>
  app.request(`/attachments?${query}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: body as RequestInit['body'],
  });

const chat = async (
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
): Promise<Response> =>
  app.request('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

type Meta = { id: string; name: string; mediaType: string; size: number; sha256: string };

describe('添付: アップロードから クローンのターンまで', () => {
  it('PNG を上げて /chat に結び付けると、ターンの入力に同じ base64 の image ブロックが在る', async () => {
    const { app, stores, blocks } = setupApp();
    const up = await upload(app, PNG);
    expect(up.status).toBe(200);
    const meta = (await up.json()) as Meta & { uploadedBy?: string };
    expect(meta.name).toBe('shot.png');
    expect(meta.uploadedBy).toBe('operator');

    const res = await chat(app, {
      text: 'これを見て',
      conversationId: 'conv-a',
      attachments: [meta.id],
    });
    expect(res.status).toBe(200);
    await res.text(); // `done` で閉じるまで読む

    expect(blocks).toHaveLength(1);
    const content = blocks[0] as { type: string; text?: string; source?: unknown }[];
    expect(content.filter((b) => b.type === 'image')).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
    ]);
    const textBlock = content.find((b) => b.type === 'text');
    expect(textBlock?.text).toContain(`[添付] id=${meta.id} name=shot.png type=image/png`);

    // 日誌: メタデータは在り、bytes は無い。
    const journal = await stores.journal.list({});
    const inbound = journal.find(
      (e) => e.type === 'exchange' && e.role === 'inbound' && e.with === 'human',
    );
    expect(inbound?.type === 'exchange' ? inbound.attachments : undefined).toEqual([
      {
        id: meta.id,
        name: 'shot.png',
        mediaType: 'image/png',
        size: PNG.length,
        sha256: meta.sha256,
      },
    ]);
    expect(JSON.stringify(journal)).not.toContain(PNG_BASE64);

    // GET /conversations/:id にもメタデータが載る。
    const detail = (await (await app.request('/conversations/conv-a')).json()) as {
      messages: { attachments?: Meta[] }[];
    };
    expect(detail.messages.some((m) => m.attachments?.[0]?.id === meta.id)).toBe(true);
  });

  it('GET /attachments/:id は中身と守りのヘッダを返し、/meta は控えだけ、無ければ 404', async () => {
    const { app } = setupApp();
    const meta = (await (
      await upload(app, PNG, 'name=%E5%86%99%E7%9C%9F.png&type=image%2Fpng')
    ).json()) as Meta;
    const res = await app.request(`/attachments/${meta.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment;');
    expect(disposition).toContain("filename*=UTF-8''%E5%86%99%E7%9C%9F.png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);

    const m = await app.request(`/attachments/${meta.id}/meta`);
    expect(((await m.json()) as Meta).sha256).toBe(meta.sha256);
    expect((await app.request('/attachments/nope')).status).toBe(404);
    expect((await app.request('/attachments/nope/meta')).status).toBe(404);
  });

  it('octet-stream 以外の content-type は 415', async () => {
    const { app } = setupApp();
    for (const type of ['application/json', 'text/plain', 'multipart/form-data', '']) {
      const res = await upload(app, PNG, 'name=a.png&type=image%2Fpng', type);
      expect(res.status, type).toBe(415);
    }
  });

  it('上限を超える本文は 413、中身が宣言と違えば 400', async () => {
    const { app } = setupApp({
      limits: { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: 20, maxFileBytes: 20 },
    });
    const big = await upload(app, new Uint8Array(21), 'name=a.bin&type=application%2Foctet-stream');
    expect(big.status).toBe(413);
    const bad = await upload(app, new Uint8Array(10), 'name=a.png&type=image%2Fpng');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('magic_mismatch');
  });

  it('別の会話に結び付いた添付・存在しない添付を付けた /chat は 400 で、受信箱に入れない', async () => {
    const { app, stores } = setupApp();
    const meta = (await (await upload(app, PNG)).json()) as Meta;
    await (
      await chat(app, { text: '1回目', conversationId: 'conv-a', attachments: [meta.id] })
    ).text();

    const conflict = await chat(app, {
      text: '別会話',
      conversationId: 'conv-b',
      attachments: [meta.id],
    });
    expect(conflict.status).toBe(400);
    expect(((await conflict.json()) as { code: string }).code).toBe('attachment_conflict');

    const missing = await chat(app, {
      text: '無い',
      conversationId: 'conv-b',
      attachments: ['ghost'],
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { code: string }).code).toBe('attachment_missing');

    const journal = await stores.journal.list({ types: ['exchange'], with: ['human'] });
    expect(journal.some((e) => e.type === 'exchange' && e.text === '別会話')).toBe(false);
    expect(journal.some((e) => e.type === 'exchange' && e.text === '無い')).toBe(false);
  });

  it('個数が上限を超える /chat は 400', async () => {
    const { app } = setupApp({ limits: { ...DEFAULT_ATTACHMENT_LIMITS, maxPerMessage: 1 } });
    const a = (await (await upload(app, PNG)).json()) as Meta;
    const b = (await (await upload(app, PNG)).json()) as Meta;
    const res = await chat(app, { text: 'x', conversationId: 'c', attachments: [a.id, b.id] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('too_many');
  });
});

describe('添付: 認証', () => {
  it('認証が有効な構成では、資格の無い /attachments は受けない（読みも書きも 401）', async () => {
    const stores: Stores = createMemoryStores();
    const app = createApp({
      clone: {} as unknown as CloneHost,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      auth: {
        plan: {
          enabled: true,
          providers: [],
          publicBaseUrl: 'http://127.0.0.1:4517',
          tokenTtlDays: 30,
          description: 'テスト',
        },
        service: createAuthService({
          store: stores.auth,
          providers: createAuthProviderRegistry([]),
        }),
      },
    });
    expect((await upload(app, PNG)).status).toBe(401);
    const meta = await stores.attachments.put({
      name: 'a.png',
      mediaType: 'image/png',
      bytes: PNG,
    });
    expect((await app.request(`/attachments/${meta.id}`)).status).toBe(401);
    expect((await app.request(`/attachments/${meta.id}/meta`)).status).toBe(401);
    // 持ち主の資格なら通る（陽性対照）。
    const ok = await app.request('/attachments?name=a.png&type=image%2Fpng', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer test-token' },
      body: PNG as RequestInit['body'],
    });
    expect(ok.status).toBe(200);
  });
});

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
  MemoryAttachmentStore,
  type CloneHost,
  type Stores,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5]);
const PNG_BASE64 = Buffer.from(PNG).toString('base64');

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

function setupApp(
  options: { limits?: typeof DEFAULT_ATTACHMENT_LIMITS; attachmentsNow?: () => Date } = {},
) {
  const stores =
    options.attachmentsNow === undefined
      ? createMemoryStores()
      : {
          ...createMemoryStores(),
          attachments: new MemoryAttachmentStore({ now: options.attachmentsNow }),
        };
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

// 種は inbound にしない: 「受信箱・日誌に積まれていない」を測る検査が種を人間の発言と取り違えないため。
async function seedConversations(stores: Stores, ...ids: string[]): Promise<void> {
  for (const conversationId of ids) {
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '(種)',
      conversationId,
    });
  }
}

type Meta = { id: string; name: string; mediaType: string; size: number; sha256: string };

describe('添付: アップロードから クローンのターンまで', () => {
  it('PNG を上げて /chat に結び付けると、ターンの入力に同じ base64 の image ブロックが在る', async () => {
    const { app, stores, blocks } = setupApp();
    await seedConversations(stores, 'conv-a');
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
    await res.text();

    expect(blocks).toHaveLength(1);
    const content = blocks[0] as { type: string; text?: string; source?: unknown }[];
    expect(content.filter((b) => b.type === 'image')).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
    ]);
    const textBlock = content.find((b) => b.type === 'text');
    expect(textBlock?.text).toContain(`[添付] id=${meta.id} name=shot.png type=image/png`);

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

  it('画像の宣言で幅か高さが 8000px を超えるものは 400 image_dimension_too_large で、何が超えたかを言う（#3697）', async () => {
    const { app } = setupApp();
    const png = (w: number, h: number) =>
      Uint8Array.from([
        ...PNG.subarray(0, 8),
        0,
        0,
        0,
        13,
        0x49,
        0x48,
        0x44,
        0x52,
        ...[w, h].flatMap((n) => [
          (n >>> 24) & 0xff,
          (n >>> 16) & 0xff,
          (n >>> 8) & 0xff,
          n & 0xff,
        ]),
        8,
        6,
        0,
        0,
        0,
      ]);
    expect((await upload(app, png(8000, 8000))).status).toBe(200);
    const wide = await upload(app, png(8001, 10));
    expect(wide.status).toBe(400);
    expect(await wide.json()).toEqual({
      error: '画像の寸法は幅・高さとも 8000 px まで（8001 × 10 px ある）',
      code: 'image_dimension_too_large',
    });
    const tall = await upload(app, png(10, 8001));
    expect(tall.status).toBe(400);
    expect(((await tall.json()) as { code: string }).code).toBe('image_dimension_too_large');
    const asFile = await upload(app, png(8001, 8001), 'name=a.bin&type=application%2Foctet-stream');
    expect(asFile.status).toBe(200);
  });

  it('画像の大きさの上限超過は 413 too_large で、上限を人が読める単位で言う', async () => {
    const { app } = setupApp({
      limits: {
        ...DEFAULT_ATTACHMENT_LIMITS,
        maxImageBytes: 5 * 1024 * 1024,
        maxFileBytes: 6 * 1024 * 1024,
      },
    });
    const over = new Uint8Array(5 * 1024 * 1024 + 1);
    over.set(PNG);
    const res = await upload(app, over);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: '画像は 1 つ 5 MiB まで（5,242,881 バイトある）',
      code: 'too_large',
    });
  });

  it('0 バイトの本文は 400 empty（415・JSON のパース・413 に落ちない）。画像の宣言でも同じ（#3327）', async () => {
    const { app } = setupApp();
    for (const query of ['name=e.txt&type=text%2Fplain', 'name=e.png&type=image%2Fpng']) {
      const res = await upload(app, new Uint8Array(0), query);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe('empty');
      expect(body.error).toContain('空のファイルは添えられない');
    }
  });

  it('別の会話に結び付いた添付・存在しない添付を付けた /chat は 400 で、受信箱に入れない', async () => {
    const { app, stores } = setupApp();
    await seedConversations(stores, 'conv-a', 'conv-b');
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

  it('担い手の報告に結び付いた添付は、控えに managerReportId が出て、/chat には付けられない（#4126 P2b）', async () => {
    const { app, stores } = setupApp();
    await seedConversations(stores, 'conv-a');
    const meta = (await (await upload(app, PNG)).json()) as Meta;
    await stores.attachments.bindToManagerReport([meta.id], 'report-1');

    const shown = (await (await app.request(`/attachments/${meta.id}/meta`)).json()) as {
      managerReportId?: string;
      conversationId?: string;
    };
    expect(shown.managerReportId).toBe('report-1');
    expect(shown.conversationId).toBeUndefined();

    const conflict = await chat(app, {
      text: '報告の添付を付ける',
      conversationId: 'conv-a',
      attachments: [meta.id],
    });
    expect(conflict.status).toBe(400);
    expect(((await conflict.json()) as { code: string }).code).toBe('attachment_conflict');
    const journal = await stores.journal.list({ types: ['exchange'], with: ['human'] });
    expect(journal.some((e) => e.type === 'exchange' && e.text === '報告の添付を付ける')).toBe(
      false,
    );
  });

  it('期限（expiresAt）を過ぎた添付は、prune の前でも GET は 404・/chat の結び付けは attachment_missing（#3522）', async () => {
    let now = new Date('2026-06-01T00:00:00.000Z');
    const { app, stores } = setupApp({ attachmentsNow: () => now });
    await seedConversations(stores, 'conv-x');
    const meta = (await (await upload(app, PNG)).json()) as Meta & { expiresAt: string };
    expect((await app.request(`/attachments/${meta.id}`)).status).toBe(200);
    now = new Date(meta.expiresAt);
    expect((await app.request(`/attachments/${meta.id}`)).status).toBe(404);
    expect((await app.request(`/attachments/${meta.id}/meta`)).status).toBe(404);

    const res = await chat(app, {
      text: '期限切れ',
      conversationId: 'conv-x',
      attachments: [meta.id],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('attachment_missing');
    expect(body.error).toContain('添付が見つからない（期限切れの可能性）');
    expect(body.error).toContain(meta.id);
    const journal = await stores.journal.list({ types: ['exchange'], with: ['human'] });
    expect(journal.some((e) => e.type === 'exchange' && e.text === '期限切れ')).toBe(false);
  });

  it('個数が上限を超える /chat は 400', async () => {
    const { app, stores } = setupApp({
      limits: { ...DEFAULT_ATTACHMENT_LIMITS, maxPerMessage: 1 },
    });
    await seedConversations(stores, 'c');
    const a = (await (await upload(app, PNG)).json()) as Meta;
    const b = (await (await upload(app, PNG)).json()) as Meta;
    const res = await chat(app, { text: 'x', conversationId: 'c', attachments: [a.id, b.id] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('too_many');
  });
});

describe('GET /attachments/limits（#3204）', () => {
  it('createApp が実際に使っている上限をそのまま返す（既定値ではない）', async () => {
    const limits = {
      maxImageBytes: 7 * 1024 * 1024,
      maxFileBytes: 31 * 1024 * 1024,
      maxLargeFileBytes: 0,
      maxPerMessage: 3,
      maxTotalBytes: 40 * 1024 * 1024,
      retentionDays: 2,
    };
    const { app } = setupApp({ limits });
    const res = await app.request('/attachments/limits', {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(limits);
  });

  it('`limits` を添付の id と取り違えない（id としては 404 のまま）', async () => {
    const { app } = setupApp();
    const headers = { authorization: 'Bearer test-token' };
    expect((await app.request('/attachments/limits/meta', { headers })).status).toBe(404);
    expect((await app.request('/attachments/nonexistent', { headers })).status).toBe(404);
  });

  it('認証が有効な構成では、資格が無ければ 401 で、持ち主の資格なら 200', async () => {
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
    expect((await app.request('/attachments/limits')).status).toBe(401);
    const ok = await app.request('/attachments/limits', {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { maxPerMessage: number }).maxPerMessage).toBe(
      DEFAULT_ATTACHMENT_LIMITS.maxPerMessage,
    );
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
    const ok = await app.request('/attachments?name=a.png&type=image%2Fpng', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer test-token' },
      body: PNG as RequestInit['body'],
    });
    expect(ok.status).toBe(200);
  });
});

describe('添付だけの発言（本文が空）', () => {
  it('空本文と添付1件は 200 で、ターンの入力に image ブロックと通知行が在る', async () => {
    const { app, stores, blocks } = setupApp();
    await seedConversations(stores, 'conv-e');
    const meta = (await (await upload(app, PNG)).json()) as Meta;
    const res = await chat(app, { text: '', conversationId: 'conv-e', attachments: [meta.id] });
    expect(res.status).toBe(200);
    await res.text();

    expect(blocks).toHaveLength(1);
    const content = blocks[0] as { type: string; text?: string }[];
    expect(content.filter((b) => b.type === 'image')).toHaveLength(1);
    const text = content.find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain(
      `[添付] id=${meta.id} name=shot.png type=image/png size=${PNG.length} sha256=${meta.sha256}（画像として渡した）`,
    );
  });

  it('空本文で添付が無ければ（attachments が空配列でも）従来どおり 400', async () => {
    const { app, stores } = setupApp();
    expect((await chat(app, { text: '' })).status).toBe(400);
    expect((await chat(app, { text: '', attachments: [] })).status).toBe(400);
    expect(await stores.journal.list({ types: ['exchange'], with: ['human'] })).toEqual([]);
  });
});

describe('孤立サロゲートを含む会話 id は入口で断る（#3560）', () => {
  it.each([
    ['上位だけ', 'conv-\ud83d'],
    ['下位だけ', 'conv-\ude00-x'],
    ['上位の後ろに下位でないもの', 'conv-\ud83dx'],
  ])('%s: 400 で、何も積まず、添付も結ばない', async (_label, conversationId) => {
    const { app, stores } = setupApp();
    const meta = (await (await upload(app, PNG)).json()) as Meta;

    const res = await chat(app, { text: '孤立', conversationId, attachments: [meta.id] });

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('conversationId');
    expect(body).not.toContain(conversationId);
    const journal = await stores.journal.list({ types: ['exchange'], with: ['human'] });
    expect(journal.some((e) => e.type === 'exchange' && e.text === '孤立')).toBe(false);
    expect((await stores.inbox.peekPending()).entries).toEqual([]);
    expect((await stores.attachments.getMeta(meta.id))?.conversationId).toBeUndefined();
  });

  it('正しいサロゲート対（絵文字）を含む会話 id は従来どおり通り、添付も結ばれる', async () => {
    const { app, stores } = setupApp();
    await seedConversations(stores, 'conv-\u{1f600}');
    const meta = (await (await upload(app, PNG)).json()) as Meta;
    const res = await chat(app, {
      text: '絵文字',
      conversationId: 'conv-\u{1f600}',
      attachments: [meta.id],
    });
    expect(res.status).toBe(200);
    await res.text();
    expect((await stores.attachments.getMeta(meta.id))?.conversationId).toBe('conv-\u{1f600}');
  });
});

describe('NUL を含む会話 id は入口で断る（#3631）', () => {
  it('添付つき: 500 にせず 400 で断り、何も積まず、添付も結ばない', async () => {
    const { app, stores } = setupApp();
    const meta = (await (await upload(app, PNG)).json()) as Meta;

    const res = await chat(app, {
      text: 'nul',
      conversationId: 'conv-\u0000x',
      attachments: [meta.id],
    });

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('conversationId');
    expect(body).not.toContain('\u0000');
    expect(body).not.toContain('u0000');
    const journal = await stores.journal.list({ types: ['exchange'], with: ['human'] });
    expect(journal.some((e) => e.type === 'exchange' && e.text === 'nul')).toBe(false);
    expect((await stores.inbox.peekPending()).entries).toEqual([]);
    expect((await stores.attachments.getMeta(meta.id))?.conversationId).toBeUndefined();
  });

  it('添付なし: 400 で断り、何も積まない', async () => {
    const { app, stores } = setupApp();

    const res = await chat(app, { text: 'nul-no-attach', conversationId: 'conv-\u0000x' });

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('conversationId');
    expect(body).not.toContain('\u0000');
    expect(body).not.toContain('u0000');
    const journal = await stores.journal.list({ types: ['exchange'], with: ['human'] });
    expect(journal.some((e) => e.type === 'exchange' && e.text === 'nul-no-attach')).toBe(false);
    expect((await stores.inbox.peekPending()).entries).toEqual([]);
  });
});

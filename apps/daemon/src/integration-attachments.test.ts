/**
 * 連携の鍵で上げた添付を外部イベントに付ける（#3113 段3）。**本物の `createClone`（偽 SDK のみ差し替え）と本物の
 * `createApp`** を組み、「鍵で `POST /attachments` → `POST /events` に id を付けて送る → クローンのターンに
 * image ブロックが届く」を端から端まで確かめる。守るもの: ①鍵が付けられるのは**同じ鍵**が上げた添付だけ
 * ②弾くときはイベントを投函しない ③鍵は添付を読めない（403） ④本文の上限（maxBodyBytes）は `/events*` にだけ
 * 掛かり、添付のアップロードには掛からない ⑤アップロードも鍵の回数に数える。**時計は偽物で、実時間は待たない。**
 */
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ALWAYS_REDELIVER,
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  createClone,
  createLocalRunner,
  createMemoryStores,
  createRunnerRegistry,
  DEFAULT_ATTACHMENT_LIMITS,
  MemoryAttachmentStore,
  type CloneHost,
  type InboxEvent,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const OPERATOR = { authorization: 'Bearer test-token' };
const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5]);
const PNG_BASE64 = Buffer.from(PNG).toString('base64');
const MIB = 1024 * 1024;

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

function setup(
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
  const posted: InboxEvent[] = [];
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
  // 本物のクローンを包み、投函された合図を控える（投函しないことを測るため）。
  const host = new Proxy(clone, {
    get(target, key) {
      if (key === 'post') {
        return (event: InboxEvent) => {
          posted.push(event);
          return target.post(event);
        };
      }
      if (key === 'postPersisted') {
        return (event: InboxEvent) => {
          posted.push(event);
          return target.postPersisted(event);
        };
      }
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as CloneHost;
  const app = createApp({
    clone: host,
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    now: () => new Date(T0),
    ...(options.limits === undefined ? {} : { attachmentLimits: options.limits }),
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
  return { app, stores, blocks, posted };
}

type Setup = ReturnType<typeof setup>;
const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

async function issue(
  s: Setup,
  input: Record<string, unknown> = {},
): Promise<{ id: string; value: string }> {
  const response = await s.app.request('/integration-keys', {
    method: 'POST',
    headers: { ...OPERATOR, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'ci の鍵', source: 'ci.main', ...input }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { key: { id: string }; value: string };
  return { id: body.key.id, value: body.value };
}

const upload = (
  s: Setup,
  headers: Record<string, string>,
  body: Uint8Array = PNG,
  query = 'name=shot.png&type=image%2Fpng',
) =>
  s.app.request(`/attachments?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...headers },
    body: body as RequestInit['body'],
  });

type Meta = { id: string; uploadedBy?: string; sha256: string };
const uploadOk = async (s: Setup, headers: Record<string, string>, body: Uint8Array = PNG) => {
  const response = await upload(s, headers, body);
  expect(response.status).toBe(200);
  return (await response.json()) as Meta;
};

const sendEvent = (s: Setup, headers: Record<string, string>, body: Record<string, unknown>) =>
  s.app.request('/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ source: 'ci.main', payload: { status: 'failure' }, ...body }),
  });

const sendWebhook = (s: Setup, headers: Record<string, string>, query: string, payload = '{}') =>
  s.app.request(`/events/ci.main${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: payload,
  });

const chat = async (s: Setup, text: string, attachments?: string[]) =>
  (
    await s.app.request('/chat', {
      method: 'POST',
      headers: { ...OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...(attachments === undefined ? {} : { attachments }) }),
    })
  ).text();

/** 鍵の `uploadedBy` と同じ文字列（値ではなく識別子）。 */
const uploaderOfKey = (keyId: string) => `integration:${keyId}`;

describe('連携の鍵で上げた添付を外部イベントに付ける（端から端まで）', () => {
  it('鍵で上げる → /events に id を付けて送る → クローンのターンに画像の content block が届く', async () => {
    const s = setup();
    const key = await issue(s);
    const meta = await uploadOk(s, bearer(key.value));
    expect(meta.uploadedBy).toBe(uploaderOfKey(key.id));

    const res = await sendEvent(s, bearer(key.value), { attachments: [meta.id] });
    expect(res.status).toBe(200);
    const eventId = ((await res.json()) as { id: string }).id;
    // 投函された合図は、置き場の控えから詰めた参照だけを持つ（本文には中身が無い）。
    expect(s.posted).toHaveLength(1);
    const event = s.posted[0] as Extract<InboxEvent, { type: 'external' }>;
    expect(event.attachments).toEqual([
      {
        id: meta.id,
        name: 'shot.png',
        mediaType: 'image/png',
        size: PNG.length,
        sha256: meta.sha256,
      },
    ]);
    expect((await s.stores.attachments.getMeta(meta.id))?.externalEventId).toBe(eventId);

    // ターンは直列なので、続けて送る /chat が閉じたとき、外部イベントのターンは済んでいる。
    await chat(s, '続き');
    const content = s.blocks[0] as { type: string; text?: string }[];
    expect(content.filter((b) => b.type === 'image')).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
    ]);
    const text = content.find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('外部から出来事が届いた');
    expect(text).toContain(`[添付] id=${meta.id} name=shot.png type=image/png`);

    // 日誌: メタデータは在り、bytes は無い。
    const journal = await s.stores.journal.list({});
    const row = journal.find((e) => e.type === 'external_event');
    expect(row?.type === 'external_event' ? row.attachments?.[0]?.id : undefined).toBe(meta.id);
    expect(row?.type === 'external_event' ? row.via?.keyId : undefined).toBe(key.id);
    expect(JSON.stringify(journal)).not.toContain(PNG_BASE64);
  });

  it('/events/:source はクエリ ?attachments= で同じことができる（本文は payload のまま）', async () => {
    const s = setup();
    const key = await issue(s);
    const a = await uploadOk(s, bearer(key.value));
    const b = await uploadOk(s, bearer(key.value));
    const res = await sendWebhook(
      s,
      bearer(key.value),
      `?attachments=${a.id}&attachments=${b.id}`,
      '{"zen":"x"}',
    );
    expect(res.status).toBe(200);
    const event = s.posted[0] as Extract<InboxEvent, { type: 'external' }>;
    expect(event.payload).toEqual({ zen: 'x' });
    expect(event.attachments?.map((ref) => ref.id)).toEqual([a.id, b.id]);

    // 添付を付けない呼び（クエリ無し・空の値）は従来どおり。
    expect((await sendWebhook(s, bearer(key.value), '')).status).toBe(200);
    expect((await sendWebhook(s, bearer(key.value), '?attachments=')).status).toBe(200);
    expect((s.posted[1] as { attachments?: unknown }).attachments).toBeUndefined();
    expect((s.posted[2] as { attachments?: unknown }).attachments).toBeUndefined();
  });
});

describe('鍵が付けられるのは、同じ鍵が上げた添付だけ（400。イベントは投函しない）', () => {
  it('別の鍵・別の source の鍵・operator・アカウントが上げた id は結び付けない', async () => {
    const s = setup();
    const mine = await issue(s);
    const sameSource = await issue(s, { name: '別の鍵' });
    const otherSource = await issue(s, { name: '別の source', source: 'ci.other' });
    const fromOtherKey = await uploadOk(s, bearer(sameSource.value));
    const fromOtherSource = await uploadOk(s, bearer(otherSource.value));
    const fromOperator = await uploadOk(s, OPERATOR);
    const fromAccount = await s.stores.attachments.put({
      name: 'a.png',
      mediaType: 'image/png',
      bytes: PNG,
      uploadedBy: 'account:acc-1',
    });
    const unknownUploader = await s.stores.attachments.put({
      name: 'u.png',
      mediaType: 'image/png',
      bytes: PNG,
    });
    const own = await uploadOk(s, bearer(mine.value));

    for (const id of [
      fromOtherKey.id,
      fromOtherSource.id,
      fromOperator.id,
      fromAccount.id,
      unknownUploader.id,
    ]) {
      const response = await sendEvent(s, bearer(mine.value), { attachments: [id] });
      expect(response.status, id).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'attachment_forbidden' });
      // /events/:source でも同じ。
      expect((await sendWebhook(s, bearer(mine.value), `?attachments=${id}`)).status).toBe(400);
      // 自分のものと混ぜても、1つでも他人のものがあれば全部やめる。
      expect((await sendEvent(s, bearer(mine.value), { attachments: [own.id, id] })).status).toBe(
        400,
      );
      expect((await s.stores.attachments.getMeta(id))?.externalEventId).toBeUndefined();
    }
    expect(s.posted).toHaveLength(0);
    // 自分のものは結び付いていない（検証が結び付けより先）。
    expect((await s.stores.attachments.getMeta(own.id))?.externalEventId).toBeUndefined();
    // 陽性対照: 自分のものだけなら通る。
    expect((await sendEvent(s, bearer(mine.value), { attachments: [own.id] })).status).toBe(200);
    expect(s.posted).toHaveLength(1);
  });

  it('無い id は 400 で投函しない（黙って添付を落として本文だけ送らない）', async () => {
    const s = setup();
    const key = await issue(s);
    const response = await sendEvent(s, bearer(key.value), { attachments: ['no-such-id'] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'attachment_missing' });
    expect((await sendWebhook(s, bearer(key.value), '?attachments=no-such-id')).status).toBe(400);
    expect(s.posted).toHaveLength(0);
  });

  it('期限（expiresAt）を過ぎた id は、prune の前でも 400 attachment_missing で投函しない（#3522）', async () => {
    let now = new Date(T0);
    const s = setup({ attachmentsNow: () => now });
    const key = await issue(s);
    const meta = await uploadOk(s, bearer(key.value));
    now = new Date(T0 + 31 * 86_400_000);
    const response = await sendEvent(s, bearer(key.value), { attachments: [meta.id] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'attachment_missing' });
    expect((await sendWebhook(s, bearer(key.value), `?attachments=${meta.id}`)).status).toBe(400);
    expect(s.posted).toHaveLength(0);
  });

  it('すでに別の宛先（会話・別の外部イベント）に結び付いた id は 400。/chat も外部イベントへ結び付いた id を使えない', async () => {
    const s = setup();
    const key = await issue(s);
    const used = await uploadOk(s, bearer(key.value));
    const toChat = await uploadOk(s, bearer(key.value));
    expect((await sendEvent(s, bearer(key.value), { attachments: [used.id] })).status).toBe(200);
    // 同じ id の再利用。
    const again = await sendEvent(s, bearer(key.value), { attachments: [used.id] });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: 'attachment_conflict' });
    expect(s.posted).toHaveLength(1);
    // 外部イベントへ結び付いた id は /chat に使えない（/chat 側の挙動は変えていない。ストアが conflict を返す）。
    const text = await chat(s, '使い回し', [used.id]);
    expect(text).not.toContain('event: open');
    // 会話へ結び付いた id は外部イベントに使えない（operator が送る場合でも）。
    await chat(s, '会話へ', [toChat.id]);
    const operatorSend = await sendEvent(s, OPERATOR, { attachments: [toChat.id] });
    expect(operatorSend.status).toBe(400);
    expect(await operatorSend.json()).toMatchObject({ code: 'attachment_conflict' });
    expect(s.posted.filter((e) => e.type === 'external')).toHaveLength(1);
  });

  it('個数の上限（too_many）は 400 で投函しない', async () => {
    const s = setup({ limits: { ...DEFAULT_ATTACHMENT_LIMITS, maxPerMessage: 1 } });
    const key = await issue(s);
    const a = await uploadOk(s, bearer(key.value));
    const b = await uploadOk(s, bearer(key.value));
    const response = await sendEvent(s, bearer(key.value), { attachments: [a.id, b.id] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'too_many' });
    expect(s.posted).toHaveLength(0);
  });

  it('人間・operator が送るときは /chat と同じ規則: 上げた主体は問わない（鍵が上げたものも付けられる）', async () => {
    const s = setup();
    const key = await issue(s);
    const fromKey = await uploadOk(s, bearer(key.value));
    const fromOperator = await uploadOk(s, OPERATOR);
    const res = await sendEvent(s, OPERATOR, { attachments: [fromKey.id, fromOperator.id] });
    expect(res.status).toBe(200);
    expect(s.posted).toHaveLength(1);
    // operator が送ったので via は付かない。
    expect((s.posted[0] as { via?: unknown }).via).toBeUndefined();
  });
});

describe('鍵の能力は「自分の送信に付ける添付のアップロード」まで（読めない）', () => {
  it('GET /attachments/:id と /meta は 403。ほかの口も 403 のまま', async () => {
    const s = setup();
    const key = await issue(s);
    const meta = await uploadOk(s, bearer(key.value));
    await captureStderr(async () => {
      expect(
        (await s.app.request(`/attachments/${meta.id}`, { headers: bearer(key.value) })).status,
      ).toBe(403);
      expect(
        (await s.app.request(`/attachments/${meta.id}/meta`, { headers: bearer(key.value) }))
          .status,
      ).toBe(403);
      expect(
        (await s.app.request('/attachments', { method: 'DELETE', headers: bearer(key.value) }))
          .status,
      ).toBe(403);
      expect(
        (await s.app.request('/chat', { method: 'POST', headers: bearer(key.value) })).status,
      ).toBe(403);
    });
    // 陽性対照: 持ち主は読める。
    expect((await s.app.request(`/attachments/${meta.id}`, { headers: OPERATOR })).status).toBe(
      200,
    );
  });

  it('アップロードの規則は人間と同じ: octet-stream 以外は 415、中身が宣言と違えば 400、添付の上限超えは 413', async () => {
    const s = setup({
      limits: { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: 20, maxFileBytes: 20 },
    });
    const key = await issue(s);
    const json = await s.app.request('/attachments?type=image%2Fpng', {
      method: 'POST',
      headers: { ...bearer(key.value), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(json.status).toBe(415);
    expect((await upload(s, bearer(key.value), new Uint8Array(10))).status).toBe(400);
    expect(
      (
        await upload(
          s,
          bearer(key.value),
          new Uint8Array(21),
          'name=a.bin&type=application%2Foctet-stream',
        )
      ).status,
    ).toBe(413);
  });
});

describe('本文の上限（maxBodyBytes）は /events* にだけ掛かり、アップロードには掛からない', () => {
  it('1 MiB を超える画像は添付の上限内なら上げられ、同じ大きさの /events の本文は 413', async () => {
    const s = setup();
    const key = await issue(s); // 既定 1 MiB
    const big = new Uint8Array(1.5 * MIB);
    big.set(PNG);
    const meta = await uploadOk(s, bearer(key.value), big);
    // 付けて送れる（イベントの本文は小さい）。
    expect((await sendEvent(s, bearer(key.value), { attachments: [meta.id] })).status).toBe(200);
    // 陽性対照: イベントの本文には鍵の上限が掛かる。
    const tooBig = JSON.stringify({ source: 'ci.main', payload: 'x'.repeat(1.5 * MIB) });
    await captureStderr(async () => {
      expect(
        (
          await s.app.request('/events', {
            method: 'POST',
            headers: { ...bearer(key.value), 'content-type': 'application/json' },
            body: tooBig,
          })
        ).status,
      ).toBe(413);
      expect((await sendWebhook(s, bearer(key.value), '', tooBig)).status).toBe(413);
    });
    expect(s.posted).toHaveLength(1);
  });

  it('maxBodyBytes を小さく切った鍵でも、添付は添付の上限まで上げられる', async () => {
    const s = setup();
    const key = await issue(s, { maxBodyBytes: 200 });
    const meta = await uploadOk(
      s,
      bearer(key.value),
      new Uint8Array([...PNG, ...new Array(500).fill(0)]),
    );
    expect((await sendEvent(s, bearer(key.value), { attachments: [meta.id] })).status).toBe(200);
  });
});

describe('回数: アップロードも鍵の1回に数える（偽の時計）', () => {
  it('ratePerMinute: 2 の鍵は、アップロード2回で窓を使い切り、3回目は 429', async () => {
    const s = setup();
    const key = await issue(s, { ratePerMinute: 2 });
    const a = await uploadOk(s, bearer(key.value));
    await uploadOk(s, bearer(key.value));
    await captureStderr(async () => {
      const third = await sendEvent(s, bearer(key.value), { attachments: [a.id] });
      expect(third.status).toBe(429);
      expect(third.headers.get('retry-after')).not.toBeNull();
    });
    expect(s.posted).toHaveLength(0);
  });
});

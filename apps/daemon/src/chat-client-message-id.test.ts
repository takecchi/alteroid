/**
 * `POST /chat` の `clientMessageId`（Issue #3203）。**本物の `createClone`（偽 SDK のみ差し替え）と本物の
 * `createApp`** で、受信箱 → 日誌 → `open` / `GET /conversations/:id` まで通し、同じ id の再送が二重に
 * 受けられないことを確かめる。
 */
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ALWAYS_REDELIVER,
  createClone,
  createLocalRunner,
  createMemoryStores,
  createRunnerRegistry,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

/** 入力ごとに1往復だけ返す偽 SDK。受け取った入力の数を `inputs` に数える。 */
function countingSdk(inputs: {
  count: number;
}): typeof import('@anthropic-ai/claude-agent-sdk').query {
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
      for await (const message of prompt as AsyncIterable<unknown>) {
        void message;
        inputs.count += 1;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '了解' }] },
          parent_tool_use_id: null,
          session_id: 's',
          uuid: `u-a-${inputs.count}`,
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: '了解',
          session_id: 's',
          uuid: `u-r-${inputs.count}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query;
}

function setupApp() {
  const stores = createMemoryStores();
  const inputs = { count: 0 };
  const queryFn = countingSdk(inputs);
  const clone = createClone({
    stores,
    queryFn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  const app = createApp({ clone, stores, token: 'test-token', shutdown: () => undefined });
  return { app, stores, inputs };
}

type App = ReturnType<typeof createApp>;

const post = async (app: App, body: Record<string, unknown>): Promise<Response> =>
  app.request('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** SSE の本文を、`event` と `data`（JSON）の並びに解く。コメント行は読み捨てる。 */
function events(text: string): { event: string; data: Record<string, unknown> }[] {
  return text
    .split('\n\n')
    .map((block) => block.split('\n'))
    .flatMap((lines) => {
      const event = lines
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim();
      const data = lines
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim();
      return event === undefined || data === undefined
        ? []
        : [{ event, data: JSON.parse(data) as Record<string, unknown> }];
    });
}

async function sendAndRead(app: App, body: Record<string, unknown>) {
  const res = await post(app, body);
  expect(res.status).toBe(200);
  return events(await res.text());
}

/** 日誌にある、人間の inbound の発言。 */
async function inboundOf(stores: ReturnType<typeof createMemoryStores>) {
  const journal = await stores.journal.list({});
  return journal.filter(
    (entry) => entry.type === 'exchange' && entry.with === 'human' && entry.role === 'inbound',
  );
}

describe('POST /chat の clientMessageId', () => {
  it('open と GET /conversations/:id の messages と日誌に、同じ clientMessageId が出る', async () => {
    const { app, stores } = setupApp();
    const sent = await sendAndRead(app, {
      text: 'こんにちは',
      conversationId: 'conv-a',
      clientMessageId: 'cmid-1',
    });
    expect(sent.find((e) => e.event === 'open')?.data).toEqual({
      conversationId: 'conv-a',
      clientMessageId: 'cmid-1',
    });

    const inbound = await inboundOf(stores);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.type === 'exchange' ? inbound[0].clientMessageId : undefined).toBe('cmid-1');

    const detail = (await (await app.request('/conversations/conv-a')).json()) as {
      messages: { role: string; text: string; clientMessageId?: string }[];
    };
    const mine = detail.messages.find((m) => m.role === 'inbound');
    expect(mine?.clientMessageId).toBe('cmid-1');
    // クローンの返事には付かない。
    expect(detail.messages.find((m) => m.role === 'outbound')?.clientMessageId).toBeUndefined();
  });

  it('付けずに送った発言には、open にも履歴にも欄を作らない（既存の形のまま）', async () => {
    const { app } = setupApp();
    const sent = await sendAndRead(app, { text: 'やあ', conversationId: 'conv-b' });
    expect(sent.find((e) => e.event === 'open')?.data).toEqual({ conversationId: 'conv-b' });
    const detail = (await (await app.request('/conversations/conv-b')).json()) as {
      messages: Record<string, unknown>[];
    };
    for (const message of detail.messages) expect('clientMessageId' in message).toBe(false);
  });

  it('形の不正は 400（空・空白・長すぎる・日本語・文字列でない）。何も積まない', async () => {
    const { app, stores } = setupApp();
    for (const bad of ['', 'a b', 'x'.repeat(129), '日本語', 'a/b', 'a\u0000b', 123, null]) {
      const res = await post(app, { text: 'x', conversationId: 'conv-c', clientMessageId: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await inboundOf(stores)).toHaveLength(0);
    // 境界: 128 字・UUID は通る。
    for (const good of ['x'.repeat(128), crypto.randomUUID(), 'A_b-9']) {
      const res = await post(app, { text: 'x', conversationId: 'conv-c', clientMessageId: good });
      expect(res.status, good).toBe(200);
      await res.text();
    }
  });

  it('同じ会話への同じ clientMessageId の再送は、二重に受けない（open は duplicate、日誌・ターンは1回）', async () => {
    const { app, stores, inputs } = setupApp();
    await sendAndRead(app, { text: '一度だけ', conversationId: 'conv-d', clientMessageId: 'once' });
    const again = await sendAndRead(app, {
      text: '一度だけ',
      conversationId: 'conv-d',
      clientMessageId: 'once',
    });
    expect(again.find((e) => e.event === 'open')?.data).toEqual({
      conversationId: 'conv-d',
      clientMessageId: 'once',
      duplicate: true,
    });
    expect(await inboundOf(stores)).toHaveLength(1);
    expect(inputs.count).toBe(1);
  });

  it('日誌に載った後（メモリの記憶が無い別のアプリ）でも、再送は二重に受けない', async () => {
    const first = setupApp();
    await sendAndRead(first.app, {
      text: '再起動前',
      conversationId: 'conv-e',
      clientMessageId: 'persist',
    });
    // 同じ器（stores）を別の `createApp` が使う = プロセスが入れ替わった後。
    const queryFn = countingSdk({ count: 0 });
    const clone = createClone({
      stores: first.stores,
      queryFn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn, env: {} }),
      ]),
      redeliveryGate: ALWAYS_REDELIVER,
    });
    const reborn = createApp({
      clone,
      stores: first.stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
    const again = await sendAndRead(reborn, {
      text: '再起動前',
      conversationId: 'conv-e',
      clientMessageId: 'persist',
    });
    expect(again.find((e) => e.event === 'open')?.data).toMatchObject({ duplicate: true });
    expect(await inboundOf(first.stores)).toHaveLength(1);
  });

  it('新しい会話（conversationId 無し）の再送は、最初に決まった会話を指す', async () => {
    const { app, stores } = setupApp();
    const first = await sendAndRead(app, { text: '新規', clientMessageId: 'fresh' });
    const conversationId = first.find((e) => e.event === 'open')?.data.conversationId;
    expect(typeof conversationId).toBe('string');
    const again = await sendAndRead(app, { text: '新規', clientMessageId: 'fresh' });
    expect(again.find((e) => e.event === 'open')?.data).toEqual({
      conversationId,
      clientMessageId: 'fresh',
      duplicate: true,
    });
    expect(await inboundOf(stores)).toHaveLength(1);
  });

  it('同時に届いた同じ clientMessageId は、片方だけが受けられる', async () => {
    const { app, stores } = setupApp();
    const [a, b] = await Promise.all([
      post(app, { text: '同時', conversationId: 'conv-f', clientMessageId: 'race' }),
      post(app, { text: '同時', conversationId: 'conv-f', clientMessageId: 'race' }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const opens = [events(await a.text()), events(await b.text())].map(
      (list) => list.find((e) => e.event === 'open')?.data,
    );
    expect(opens.filter((open) => open?.duplicate === true)).toHaveLength(1);
    expect(await inboundOf(stores)).toHaveLength(1);
  });

  it('別の会話で受け取り済みの clientMessageId は 409（積まない）', async () => {
    const { app, stores } = setupApp();
    await sendAndRead(app, { text: 'a', conversationId: 'conv-g1', clientMessageId: 'shared' });
    const res = await post(app, {
      text: 'b',
      conversationId: 'conv-g2',
      clientMessageId: 'shared',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('client_message_id_conflict');
    expect(await inboundOf(stores)).toHaveLength(1);
  });

  it('編集（supersedes）の再送も二重に受けず、自分自身に 400 を返さない', async () => {
    const { app, stores } = setupApp();
    await sendAndRead(app, { text: '最初', conversationId: 'conv-h', clientMessageId: 'orig' });
    const original = (await inboundOf(stores))[0];
    expect(original).toBeDefined();
    const edit = {
      text: '直した',
      conversationId: 'conv-h',
      supersedes: original?.id,
      clientMessageId: 'edit-1',
    };
    await sendAndRead(app, edit);
    const again = await sendAndRead(app, edit);
    expect(again.find((e) => e.event === 'open')?.data).toMatchObject({ duplicate: true });
    expect(await inboundOf(stores)).toHaveLength(2);
  });

  it('同じ本文でも clientMessageId が違えば、別の発言として受ける', async () => {
    const { app, stores } = setupApp();
    await sendAndRead(app, { text: '同じ本文', conversationId: 'conv-i', clientMessageId: 'one' });
    await sendAndRead(app, { text: '同じ本文', conversationId: 'conv-i', clientMessageId: 'two' });
    expect(await inboundOf(stores)).toHaveLength(2);
  });

  describe('中身の違う重複は 409（client_message_id_mismatch、Issue #3243）', () => {
    const PNG1 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5]);
    const PNG2 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

    async function upload(app: App, bytes: Uint8Array): Promise<string> {
      const res = await app.request('/attachments?name=shot.png&type=image%2Fpng', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes as RequestInit['body'],
      });
      return ((await res.json()) as { id: string }).id;
    }

    async function expectMismatch(res: Response) {
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code?: string }).code).toBe('client_message_id_mismatch');
    }

    it('本文が違う再送は 409。1回目の本文だけが日誌に残り、ターンは増えない', async () => {
      const { app, stores, inputs } = setupApp();
      await sendAndRead(app, { text: '一回目', conversationId: 'conv-m1', clientMessageId: 'mm1' });
      await expectMismatch(
        await post(app, { text: '直した', conversationId: 'conv-m1', clientMessageId: 'mm1' }),
      );
      const rows = await inboundOf(stores);
      expect(rows.map((e) => (e.type === 'exchange' ? e.text : ''))).toEqual(['一回目']);
      expect(inputs.count).toBe(1);
    });

    it('添付が違う再送は 409。2回目の添付は結び付かない', async () => {
      const { app, stores } = setupApp();
      const a1 = await upload(app, PNG1);
      const a2 = await upload(app, PNG2);
      await sendAndRead(app, {
        text: 't',
        conversationId: 'conv-m2',
        clientMessageId: 'mm2',
        attachments: [a1],
      });
      await expectMismatch(
        await post(app, {
          text: 't',
          conversationId: 'conv-m2',
          clientMessageId: 'mm2',
          attachments: [a2],
        }),
      );
      expect((await stores.attachments.getMeta(a2))?.conversationId).toBeUndefined();
    });

    it('添付の有無が違う再送も 409', async () => {
      const { app } = setupApp();
      const a1 = await upload(app, PNG1);
      await sendAndRead(app, { text: 't', conversationId: 'conv-m3', clientMessageId: 'mm3' });
      await expectMismatch(
        await post(app, {
          text: 't',
          conversationId: 'conv-m3',
          clientMessageId: 'mm3',
          attachments: [a1],
        }),
      );
    });

    it('添付の順序・重複だけが違う再送は同じ中身として 200（duplicate）', async () => {
      const { app, stores } = setupApp();
      const a1 = await upload(app, PNG1);
      const a2 = await upload(app, PNG2);
      await sendAndRead(app, {
        text: 't',
        conversationId: 'conv-m4',
        clientMessageId: 'mm4',
        attachments: [a1, a2],
      });
      const again = await sendAndRead(app, {
        text: 't',
        conversationId: 'conv-m4',
        clientMessageId: 'mm4',
        attachments: [a2, a1, a2],
      });
      expect(again.find((e) => e.event === 'open')?.data).toMatchObject({ duplicate: true });
      expect(await inboundOf(stores)).toHaveLength(1);
    });

    it('supersedes が違う再送は 409、同じなら 200', async () => {
      const { app, stores } = setupApp();
      await sendAndRead(app, { text: '最初', conversationId: 'conv-m5', clientMessageId: 'mm5a' });
      await sendAndRead(app, { text: '二つ目', conversationId: 'conv-m5', clientMessageId: 'mm5b' });
      const [first, second] = await inboundOf(stores);
      const edit = {
        text: '直した',
        conversationId: 'conv-m5',
        supersedes: first?.id,
        clientMessageId: 'mm5c',
      };
      await sendAndRead(app, edit);
      await expectMismatch(await post(app, { ...edit, supersedes: second?.id }));
      await expectMismatch(
        await post(app, { text: '直した', conversationId: 'conv-m5', clientMessageId: 'mm5c' }),
      );
      const same = await sendAndRead(app, edit);
      expect(same.find((e) => e.event === 'open')?.data).toMatchObject({ duplicate: true });
    });

    it('日誌だけが覚えている（メモリの記憶が無い別のアプリ）ときも、中身を比べる', async () => {
      const first = setupApp();
      const a1 = await upload(first.app, PNG1);
      const body = {
        text: '再起動前\u0000',
        conversationId: 'conv-m6',
        clientMessageId: 'mm6',
        attachments: [a1],
      };
      await sendAndRead(first.app, body);
      const queryFn = countingSdk({ count: 0 });
      const clone = createClone({
        stores: first.stores,
        queryFn,
        env: {},
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn, env: {} }),
        ]),
        redeliveryGate: ALWAYS_REDELIVER,
      });
      const reborn = createApp({
        clone,
        stores: first.stores,
        token: 'test-token',
        shutdown: () => undefined,
      });
      // 同じ中身（本文の NUL は日誌が落とす。同じ正規化を通して比べるので重複と読む）。
      const same = await sendAndRead(reborn, body);
      expect(same.find((e) => e.event === 'open')?.data).toMatchObject({ duplicate: true });
      await expectMismatch(await post(reborn, { ...body, text: '別の本文' }));
      await expectMismatch(await post(reborn, { ...body, attachments: undefined }));
    });

    it('別の会話の id は、中身が違っても client_message_id_conflict のまま', async () => {
      const { app } = setupApp();
      await sendAndRead(app, { text: 'a', conversationId: 'conv-m7a', clientMessageId: 'mm7' });
      const res = await post(app, { text: 'b', conversationId: 'conv-m7b', clientMessageId: 'mm7' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code?: string }).code).toBe('client_message_id_conflict');
    });

    it('同時に届いた同じ id で本文が違う2本は、片方が 200、片方が 409（mismatch）', async () => {
      const { app, stores } = setupApp();
      const [a, b] = await Promise.all([
        post(app, { text: 'いち', conversationId: 'conv-m8', clientMessageId: 'mm8' }),
        post(app, { text: 'に', conversationId: 'conv-m8', clientMessageId: 'mm8' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(((await loser.json()) as { code?: string }).code).toBe('client_message_id_mismatch');
      await (a.status === 200 ? a : b).text();
      expect(await inboundOf(stores)).toHaveLength(1);
    });
  });
});

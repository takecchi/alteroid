/**
 * `POST /chat` の `clientMessageId`（Issue #3203）。**本物の `createClone`（偽 SDK のみ差し替え）と本物の
 * `createApp`** で、受信箱 → 日誌 → `open` / `GET /conversations/:id` まで通し、同じ id の再送が二重に
 * 受けられないことを確かめる。
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
  type CloneHost,
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
      await sendAndRead(app, {
        text: '二つ目',
        conversationId: 'conv-m5',
        clientMessageId: 'mm5b',
      });
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
      const res = await post(app, {
        text: 'b',
        conversationId: 'conv-m7b',
        clientMessageId: 'mm7',
      });
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

  describe('同時の編集の重複は、supersedes の検証より前に1本へ絞る（Issue #3254）', () => {
    it('同じ id・同じ中身の編集が同時に2本届き、1本目が先に日誌へ載っても、2本目は 400 でなく重複の 200', async () => {
      const { app, stores, inputs } = setupApp();
      await sendAndRead(app, { text: '最初', conversationId: 'conv-e1', clientMessageId: 'orig' });
      const original = (await inboundOf(stores))[0];
      expect(original).toBeDefined();
      const turnsBefore = inputs.count;

      // 2本目の supersedes 検証（journal.get）を、1本目の編集が日誌に載るまで止める。
      // 2本目が早い重複の確認を抜けたあとに、1本目が日誌へ載る順を作る（実時間の待ちは使わない）。
      let editAppended: () => void = () => {};
      const editLanded = new Promise<void>((resolve) => {
        editAppended = resolve;
      });
      const journal = stores.journal;
      const realAppend = journal.append.bind(journal);
      journal.append = async (entry) => {
        const written = await realAppend(entry);
        if (entry.type === 'exchange' && entry.supersedes !== undefined) editAppended();
        return written;
      };
      const realGet = journal.get.bind(journal);
      let gets = 0;
      journal.get = async (id) => {
        gets += 1;
        if (gets === 2) await editLanded;
        return realGet(id);
      };

      const edit = {
        text: '直した',
        conversationId: 'conv-e1',
        supersedes: original?.id,
        clientMessageId: 'edit-race',
      };
      const [a, b] = await Promise.all([post(app, edit), post(app, edit)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const opens = [events(await a.text()), events(await b.text())].map(
        (list) => list.find((e) => e.event === 'open')?.data,
      );
      expect(opens.filter((open) => open?.duplicate === true)).toHaveLength(1);
      expect(await inboundOf(stores)).toHaveLength(2);
      expect(inputs.count).toBe(turnsBefore + 1);
    });
  });

  describe('supersedes の検証に落ちた送信は id を覚えない（Issue #3254）', () => {
    it('同時に2本とも 400 でも、直した編集の再送は重複にならず受かる', async () => {
      const { app, stores } = setupApp();
      await sendAndRead(app, { text: '最初', conversationId: 'conv-e2', clientMessageId: 'o2' });
      const original = (await inboundOf(stores))[0];
      const bad = {
        text: '直した',
        conversationId: 'conv-e2',
        supersedes: 'no-such-id',
        clientMessageId: 'edit-bad',
      };
      const [x, y] = await Promise.all([post(app, bad), post(app, bad)]);
      expect([x.status, y.status]).toEqual([400, 400]);
      const ok = await post(app, { ...bad, supersedes: original?.id });
      expect(ok.status).toBe(200);
      expect(
        events(await ok.text()).find((e) => e.event === 'open')?.data.duplicate,
      ).toBeUndefined();
      expect(await inboundOf(stores)).toHaveLength(2);
    });
  });

  describe('同時の重複は、添付の検査より前に1本へ絞る（Issue #3244）', () => {
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

    it('新しい会話に同じ id・同じ添付が同時に2本届いても、片方が重複の 200 になる（400 にならない）', async () => {
      const { app, stores, inputs } = setupApp();
      const a1 = await upload(app, PNG1);
      const body = { text: 't', clientMessageId: 'cc1', attachments: [a1] };
      const [x, y] = await Promise.all([post(app, body), post(app, body)]);
      expect([x.status, y.status]).toEqual([200, 200]);
      const opens = [events(await x.text()), events(await y.text())].map(
        (list) => list.find((e) => e.event === 'open')?.data,
      );
      expect(opens.filter((open) => open?.duplicate === true)).toHaveLength(1);
      // 重複の応えは、最初に決まった会話を指す。
      expect(opens[0]?.conversationId).toBe(opens[1]?.conversationId);
      expect(await inboundOf(stores)).toHaveLength(1);
      expect(inputs.count).toBe(1);
      expect((await stores.attachments.getMeta(a1))?.conversationId).toBe(opens[0]?.conversationId);
    });

    it('別の会話の id に同時に届いて 409 になった側の添付は、結び付かない', async () => {
      const { app, stores } = setupApp();
      const a1 = await upload(app, PNG1);
      const a2 = await upload(app, PNG2);
      const [x, y] = await Promise.all([
        post(app, {
          text: 't',
          conversationId: 'conv-c2a',
          clientMessageId: 'cc2',
          attachments: [a1],
        }),
        post(app, {
          text: 't',
          conversationId: 'conv-c2b',
          clientMessageId: 'cc2',
          attachments: [a2],
        }),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      const [winner, loser] = x.status === 200 ? [x, y] : [y, x];
      expect(((await loser.json()) as { code?: string }).code).toBe('client_message_id_conflict');
      await winner.text();
      const [m1, m2] = [await stores.attachments.getMeta(a1), await stores.attachments.getMeta(a2)];
      const bound = [m1, m2].filter((m) => m?.conversationId !== undefined);
      expect(bound).toHaveLength(1);
      expect(await inboundOf(stores)).toHaveLength(1);
    });

    it('検査で落ちた送信は id を覚えない: 同時に2本とも 400 でも、直した再送は受かる', async () => {
      const { app, stores } = setupApp();
      const a1 = await upload(app, PNG1);
      const bad = {
        text: 'x',
        conversationId: 'conv-c3',
        clientMessageId: 'cc3',
        attachments: ['nope'],
      };
      const [x, y] = await Promise.all([post(app, bad), post(app, bad)]);
      // 重複の 200 にならない（1回目は受け取られていない）。
      expect([x.status, y.status]).toEqual([400, 400]);
      const ok = await post(app, { ...bad, attachments: [a1] });
      expect(ok.status).toBe(200);
      expect(
        events(await ok.text()).find((e) => e.event === 'open')?.data.duplicate,
      ).toBeUndefined();
      expect(await inboundOf(stores)).toHaveLength(1);
    });
  });
});

describe('GET /client-messages/:clientMessageId（受け取った会話を引く。Issue #3258）', () => {
  const PNG1 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5]);

  async function upload(app: App, bytes: Uint8Array): Promise<string> {
    const res = await app.request('/attachments?name=shot.png&type=image%2Fpng', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes as RequestInit['body'],
    });
    return ((await res.json()) as { id: string }).id;
  }

  it('新しい会話で受け取った id から、決まった会話の id を返す', async () => {
    const { app } = setupApp();
    const first = await sendAndRead(app, { text: '新規', clientMessageId: 'look1' });
    const conversationId = first.find((e) => e.event === 'open')?.data.conversationId;
    const res = await app.request('/client-messages/look1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversationId });
  });

  it('日誌に載った後（メモリの記憶が無い別のアプリ）でも引ける', async () => {
    const first = setupApp();
    await sendAndRead(first.app, {
      text: 'x',
      conversationId: 'conv-l2',
      clientMessageId: 'look2',
    });
    const queryFn = countingSdk({ count: 0 });
    const reborn = createApp({
      clone: createClone({
        stores: first.stores,
        queryFn,
        env: {},
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn, env: {} }),
        ]),
        redeliveryGate: ALWAYS_REDELIVER,
      }),
      stores: first.stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
    const res = await reborn.request('/client-messages/look2');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversationId: 'conv-l2' });
  });

  it('受け取っていなければ 404、形が不正なら 400。何も積まない', async () => {
    const { app, stores } = setupApp();
    expect((await app.request('/client-messages/never')).status).toBe(404);
    expect((await app.request(`/client-messages/${'a'.repeat(129)}`)).status).toBe(400);
    expect(await inboundOf(stores)).toHaveLength(0);
  });

  it('検査に落ちて取り下げられた送信の id は 404（覚えていないのと同じ）', async () => {
    const { app } = setupApp();
    const res = await post(app, {
      text: '添付つき',
      attachments: ['no-such-attachment'],
      clientMessageId: 'look3',
    });
    expect(res.status).toBe(400);
    expect((await app.request('/client-messages/look3')).status).toBe(404);
  });

  it('資格が無ければ 401（認証が有効な構成）', async () => {
    const stores = createMemoryStores();
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
    expect((await app.request('/client-messages/x')).status).toBe(401);
    expect(
      (await app.request('/client-messages/x', { headers: { authorization: 'Bearer test-token' } }))
        .status,
    ).toBe(404);
  });

  it('#3258 の流れ: 取り直した会話へ、同じ id の再送は重複の 200、直した本文（新しい id）の添付は同じ会話なら受かる', async () => {
    const { app, stores, inputs } = setupApp();
    const attachment = await upload(app, PNG1);
    // 1回目（新しい会話）。クライアントは open を見られなかったものとして、id から引き直す。
    await sendAndRead(app, {
      text: '一回目',
      attachments: [attachment],
      clientMessageId: 'adopt1',
    });
    const looked = (await (await app.request('/client-messages/adopt1')).json()) as {
      conversationId: string;
    };
    // 同じ id・同じ中身の再送は、取り直した会話へ送れば重複の 200（積まない）。
    const again = await sendAndRead(app, {
      text: '一回目',
      attachments: [attachment],
      conversationId: looked.conversationId,
      clientMessageId: 'adopt1',
    });
    expect(again.find((e) => e.event === 'open')?.data).toMatchObject({
      conversationId: looked.conversationId,
      duplicate: true,
    });
    // 直した本文（新しい id）で、同じ会話へ同じ添付を結ぶのは許される。
    const edited = await sendAndRead(app, {
      text: '直した',
      attachments: [attachment],
      conversationId: looked.conversationId,
      clientMessageId: 'adopt2',
    });
    expect(edited.find((e) => e.event === 'open')?.data).toMatchObject({
      conversationId: looked.conversationId,
    });
    expect(await inboundOf(stores)).toHaveLength(2);
    expect(inputs.count).toBe(2);
    // 取り直さずに新しい会話として送ると、添付は最初の会話に結び付いていて弾かれる（直す前の赤）。
    const wrong = await post(app, {
      text: '直した2',
      attachments: [attachment],
      clientMessageId: 'adopt3',
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { code?: string }).code).toBe('attachment_conflict');
  });
});

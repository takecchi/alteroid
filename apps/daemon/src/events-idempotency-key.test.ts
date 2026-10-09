import type { CloneHost, EventReceiptStore, InboxEvent, Stores } from '@alteroid/core';
import {
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  createMemoryStores,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const OPERATOR = { authorization: 'Bearer test-token' };
const JSON_HEADERS = { 'content-type': 'application/json' };

let stores: Stores;
let posted: InboxEvent[] = [];
let persistOutcome: 'persisted' | 'unavailable' = 'persisted';
// 永続化の完了を手で止める: 1件目が積み終わる前に2件目が来る形を、実時間の待ちを使わずに作るため
let gate: Promise<void> | undefined;

function fakeClone(): CloneHost {
  return {
    post: (event: InboxEvent) => {
      posted.push(event);
      return 'conversation-1';
    },
    postPersisted: async (event: InboxEvent) => {
      await gate;
      if (persistOutcome === 'unavailable') return 'unavailable' as const;
      posted.push(event);
      return 'persisted' as const;
    },
    subscribe: () => () => undefined,
    stop: () => Promise.resolve(),
    usageBlocked: false,
    managers: { list: () => Promise.resolve([]) },
  } as unknown as CloneHost;
}

function buildApp() {
  return createApp({
    clone: fakeClone(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
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

async function issueKey(app: App, source = 'virchamate'): Promise<string> {
  const response = await app.request('/integration-keys', {
    method: 'POST',
    headers: { ...OPERATOR, ...JSON_HEADERS },
    body: JSON.stringify({ name: `${source} の鍵`, source }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { value: string }).value;
}

function send(app: App, bearer: string, body: Record<string, unknown>) {
  return app.request('/events', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, ...JSON_HEADERS },
    body: JSON.stringify({ source: 'virchamate', payload: { text: 'こんにちは' }, ...body }),
  });
}

beforeEach(() => {
  stores = createMemoryStores();
  posted = [];
  persistOutcome = 'persisted';
  gate = undefined;
});

describe('POST /events の idempotencyKey — 送り直しを積まない（#3531）', () => {
  it('同じ鍵・同じ source・同じ目印の2件目は、積まずに1件目と同じ id を duplicate 付きで返す', async () => {
    const app = buildApp();
    const key = await issueKey(app);

    const first = await send(app, key, { idempotencyKey: 'delivery-1' });
    const second = await send(app, key, { idempotencyKey: 'delivery-1', payload: { text: '別' } });

    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { id: string; duplicate?: boolean };
    expect(firstBody.duplicate).toBeUndefined();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, id: firstBody.id, duplicate: true });
    expect(posted.map((event) => event.id)).toEqual([firstBody.id]);
  });

  it('目印が違えば、別の出来事として積む', async () => {
    const app = buildApp();
    const key = await issueKey(app);

    await send(app, key, { idempotencyKey: 'delivery-1' });
    const second = await send(app, key, { idempotencyKey: 'delivery-2' });

    expect(((await second.json()) as { duplicate?: boolean }).duplicate).toBeUndefined();
    expect(posted).toHaveLength(2);
  });

  it('目印を付けなければ、今までどおり毎回積む', async () => {
    const app = buildApp();
    const key = await issueKey(app);

    await send(app, key, {});
    await send(app, key, {});

    expect(posted).toHaveLength(2);
  });

  it('同じ source・同じ目印でも、送り手（連携の鍵）が違えば別の出来事として積む', async () => {
    const app = buildApp();
    const keyA = await issueKey(app);
    const keyB = await issueKey(app);

    await send(app, keyA, { idempotencyKey: 'delivery-1' });
    await send(app, keyB, { idempotencyKey: 'delivery-1' });

    expect(posted).toHaveLength(2);
  });

  it('同じ目印の2件が同時に来ても、積むのは1件で、両方に同じ id を返す', async () => {
    const app = buildApp();
    const key = await issueKey(app);
    let open!: () => void;
    gate = new Promise((resolve) => {
      open = resolve;
    });

    const pending = [
      send(app, key, { idempotencyKey: 'delivery-1' }),
      send(app, key, { idempotencyKey: 'delivery-1' }),
    ];
    open();
    const bodies = (await Promise.all(
      (await Promise.all(pending)).map((response) => response.json()),
    )) as { id: string }[];

    expect(posted).toHaveLength(1);
    expect(bodies[0]?.id).toBe(posted[0]?.id);
    expect(bodies[1]?.id).toBe(posted[0]?.id);
  });

  it('1件目が受信箱へ書けず 503 なら目印を覚えず、送り直しを新しい出来事として積む', async () => {
    const app = buildApp();
    const key = await issueKey(app);
    persistOutcome = 'unavailable';

    const failed = await send(app, key, { idempotencyKey: 'delivery-1' });
    persistOutcome = 'persisted';
    const retried = await send(app, key, { idempotencyKey: 'delivery-1' });

    expect(failed.status).toBe(503);
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as { duplicate?: boolean }).duplicate).toBeUndefined();
    expect(posted).toHaveLength(1);
  });

  it('operator が付けた目印も効く', async () => {
    const app = buildApp();
    const request = () =>
      app.request('/events', {
        method: 'POST',
        headers: { ...OPERATOR, ...JSON_HEADERS },
        body: JSON.stringify({ source: 'ci.main', idempotencyKey: 'run-1' }),
      });

    await request();
    const second = await request();

    expect(((await second.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    expect(posted).toHaveLength(1);
  });

  it('目印の記録が読めないときは、断らずに積む（出来事を落とさない）', async () => {
    const broken: EventReceiptStore = {
      findEventReceipt: () => Promise.reject(new Error('読めない（テスト）')),
      recordEventReceipt: () => Promise.reject(new Error('書けない（テスト）')),
    };
    stores = { ...createMemoryStores(), eventReceipts: broken };
    const app = buildApp();
    const key = await issueKey(app);

    let response!: Response;
    const lines = await captureStderr(async () => {
      response = await send(app, key, { idempotencyKey: 'delivery-1' });
    });

    expect(response.status).toBe(200);
    expect(posted).toHaveLength(1);
    expect(lines.join('')).toContain('重複キー');
  });

  it('空・長すぎる・NUL を含む目印は 400 で断り、積まない', async () => {
    const app = buildApp();
    const key = await issueKey(app);

    for (const idempotencyKey of ['', 'x'.repeat(201), 'a\u0000b']) {
      expect((await send(app, key, { idempotencyKey })).status).toBe(400);
    }
    expect(posted).toHaveLength(0);
  });
});

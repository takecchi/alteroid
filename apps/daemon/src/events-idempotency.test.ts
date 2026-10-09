import type { CloneHost, InboxEvent, Stores } from '@alteroid/core';
import { createAuthProviderRegistry, createAuthService, createMemoryStores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { AuthPlan } from './auth.js';

const OPERATOR = { authorization: 'Bearer test-token' };
const JSON_HEADERS = { 'content-type': 'application/json' };
const T0 = Date.parse('2026-06-01T00:00:00.000Z');

let stores: Stores;
let posted: InboxEvent[] = [];
let persistOutcome: 'persisted' | 'unavailable' = 'persisted';
let now = T0;

function fakeClone(): CloneHost {
  return {
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
  } as unknown as CloneHost;
}

const plan: AuthPlan = {
  enabled: true,
  providers: [],
  publicBaseUrl: 'http://127.0.0.1:4517',
  tokenTtlDays: 30,
  description: 'テスト',
};

function buildApp() {
  return createApp({
    clone: fakeClone(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    now: () => new Date(now),
    journalEvents: { subscribe: () => () => undefined },
    auth: {
      plan,
      service: createAuthService({ store: stores.auth, providers: createAuthProviderRegistry([]) }),
    },
  });
}

type App = ReturnType<typeof buildApp>;

async function issueKey(app: App, source: string): Promise<{ authorization: string }> {
  const response = await app.request('/integration-keys', {
    method: 'POST',
    headers: { ...OPERATOR, ...JSON_HEADERS },
    body: JSON.stringify({ name: `k-${source}`, source }),
  });
  const body = (await response.json()) as { value: string };
  return { authorization: `Bearer ${body.value}` };
}

function send(app: App, headers: Record<string, string>, body: unknown) {
  return app.request('/events', {
    method: 'POST',
    headers: { ...headers, ...JSON_HEADERS },
    body: JSON.stringify(body),
  });
}

interface Accepted {
  ok: true;
  id: string;
  duplicate?: true;
}

beforeEach(() => {
  stores = createMemoryStores();
  posted = [];
  persistOutcome = 'persisted';
  now = T0;
});

describe('POST /events の idempotencyKey（#3531）', () => {
  it('同じ鍵・同じ source・同じキーの2件目は積まず、1件目と同じ id を 200 で返す', async () => {
    const app = buildApp();
    const key = await issueKey(app, 'virchamate');
    const first = await send(app, key, {
      source: 'virchamate',
      payload: 'a',
      idempotencyKey: 'k1',
    });
    const second = await send(app, key, {
      source: 'virchamate',
      payload: 'a',
      idempotencyKey: 'k1',
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const one = (await first.json()) as Accepted;
    const two = (await second.json()) as Accepted;
    expect(one.duplicate).toBeUndefined();
    expect(two).toEqual({ ok: true, id: one.id, duplicate: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.id).toBe(one.id);
  });

  it('本文が違う2件目でも、1件目を返して積まない', async () => {
    const app = buildApp();
    const key = await issueKey(app, 'ci');
    const first = await send(app, key, { source: 'ci', payload: 'a', idempotencyKey: 'k1' });
    const second = await send(app, key, { source: 'ci', payload: 'CHANGED', idempotencyKey: 'k1' });
    expect(((await second.json()) as Accepted).id).toBe(((await first.json()) as Accepted).id);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ payload: 'a' });
  });

  it('キーが違う・鍵が違う・source が違う（人間の送り手を含む）ものは別に積む', async () => {
    const app = buildApp();
    const keyA = await issueKey(app, 'ci');
    const keyB = await issueKey(app, 'ci');
    const keyC = await issueKey(app, 'ci2');
    await send(app, keyA, { source: 'ci', idempotencyKey: 'same' });
    await send(app, keyA, { source: 'ci', idempotencyKey: 'other' });
    await send(app, keyB, { source: 'ci', idempotencyKey: 'same' });
    await send(app, keyC, { source: 'ci2', idempotencyKey: 'same' });
    await send(app, OPERATOR, { source: 'ci', idempotencyKey: 'same' });
    expect(posted).toHaveLength(5);
    // 人間（operator）の2件目はその送り手の中で重複になる
    const again = await send(app, OPERATOR, { source: 'ci', idempotencyKey: 'same' });
    expect(((await again.json()) as Accepted).duplicate).toBe(true);
    expect(posted).toHaveLength(5);
    // 同じ operator でも source が違えば別
    await send(app, OPERATOR, { source: 'ci-x', idempotencyKey: 'same' });
    expect(posted).toHaveLength(6);
  });

  it('キーが無い要求は今までどおり毎回積む（duplicate も付かない）', async () => {
    const app = buildApp();
    const key = await issueKey(app, 'ci');
    const a = await send(app, key, { source: 'ci', payload: 1 });
    const b = await send(app, key, { source: 'ci', payload: 1 });
    expect(posted).toHaveLength(2);
    expect(((await a.json()) as Accepted).id).not.toBe(((await b.json()) as Accepted).id);
    expect(((await b.json()) as Accepted).duplicate).toBeUndefined();
  });

  it('並行して届いても1件だけ積み、全員が同じ id を受け取る', async () => {
    const app = buildApp();
    const key = await issueKey(app, 'ci');
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => send(app, key, { source: 'ci', idempotencyKey: 'race' })),
    );
    const ids = await Promise.all(responses.map(async (r) => ((await r.json()) as Accepted).id));
    expect(new Set(ids).size).toBe(1);
    expect(posted).toHaveLength(1);
  });

  it('積めなかった（503）ときはキーを手放し、送り直しが積まれる', async () => {
    const app = buildApp();
    const key = await issueKey(app, 'ci');
    persistOutcome = 'unavailable';
    const failed = await send(app, key, { source: 'ci', idempotencyKey: 'retry' });
    expect(failed.status).toBe(503);
    persistOutcome = 'persisted';
    const retried = await send(app, key, { source: 'ci', idempotencyKey: 'retry' });
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as Accepted).duplicate).toBeUndefined();
    expect(posted).toHaveLength(1);
  });

  it('7日を過ぎたキーは新規として積む', async () => {
    const app = buildApp();
    const key = await issueKey(app, 'ci');
    await send(app, key, { source: 'ci', idempotencyKey: 'old' });
    now = T0 + 7 * 24 * 60 * 60 * 1000 - 1;
    await send(app, key, { source: 'ci', idempotencyKey: 'old' });
    expect(posted).toHaveLength(1);
    now = T0 + 7 * 24 * 60 * 60 * 1000;
    await send(app, key, { source: 'ci', idempotencyKey: 'old' });
    expect(posted).toHaveLength(2);
  });

  it.each([
    ['空文字', ''],
    ['空白だけ', '   '],
    ['201文字', 'x'.repeat(201)],
    ['NUL を含む', 'a\u0000b'],
    ['文字列でない', 5],
  ])('不正なキー（%s）は 400 で、何も積まない', async (_label, idempotencyKey) => {
    const app = buildApp();
    const response = await send(app, OPERATOR, { source: 'ci', idempotencyKey });
    expect(response.status).toBe(400);
    expect(posted).toHaveLength(0);
  });

  it('200文字ちょうどは通る', async () => {
    const response = await send(buildApp(), OPERATOR, {
      source: 'ci',
      idempotencyKey: 'x'.repeat(200),
    });
    expect(response.status).toBe(200);
    expect(posted).toHaveLength(1);
  });

  it('source が鍵と違う（403）要求はキーを取らない', async () => {
    const app = buildApp();
    const key = await issueKey(app, 'ci');
    const refused = await send(app, key, { source: 'other', idempotencyKey: 'k' });
    expect(refused.status).toBe(403);
    const ok = await send(app, key, { source: 'ci', idempotencyKey: 'k' });
    expect(((await ok.json()) as Accepted).duplicate).toBeUndefined();
    expect(posted).toHaveLength(1);
  });
});

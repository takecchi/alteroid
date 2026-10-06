import type { CloneHost, InboxEvent, Stores } from '@alteroid/core';
import {
  DAEMON_RESERVED_EVENT_SOURCES,
  createAuthProviderRegistry,
  createAuthService,
  createMemoryStores,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { AuthPlan } from './auth.js';

/**
 * **daemon が自分の名として使う予約語の source を、`POST /events` / `POST /events/:source` の入口で断る。**
 *
 * `isDaemonSelfNotice`（core）は `external` の `source` だけを見て「daemon 自身の知らせ」とみなし、台帳に載せず
 * 受信箱で畳む。外から同じ名を名乗れると、本物の外部イベント（添付つきを含む）が畳まれて届かない。
 * 名前空間の約束だけに頼らず、入口で 400 にする。**断ったら受信箱へ何も積まない・添付も結ばない。**
 * **時計は偽物で、実時間は待たない。**
 */

const OPERATOR = { authorization: 'Bearer test-token' };
const JSON_HEADERS = { 'content-type': 'application/json' };
const T0 = Date.parse('2026-06-01T00:00:00.000Z');

let stores: Stores;
let posted: InboxEvent[] = [];

function fakeClone(): CloneHost {
  return {
    post: (event: InboxEvent) => {
      posted.push(event);
      return 'conversation-1';
    },
    // `/events` は受信箱へ書けてから 200 を返す（Issue #3679）。
    postPersisted: (event: InboxEvent) => {
      posted.push(event);
      return Promise.resolve('persisted');
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
    now: () => new Date(T0),
    journalEvents: { subscribe: () => () => undefined },
    auth: {
      plan,
      service: createAuthService({ store: stores.auth, providers: createAuthProviderRegistry([]) }),
    },
  });
}

beforeEach(() => {
  stores = createMemoryStores();
  posted = [];
});

// 予約語そのもの、大文字小文字・前後の空白・全角（NFKC で同じになる）・パーセントエンコードのすり抜け。
const RESERVED_SPELLINGS = [
  'token-pool',
  'runner-registry',
  'Token-Pool',
  'RUNNER-REGISTRY',
  ' token-pool',
  'runner-registry\t',
  '　token-pool\n',
  'ｔｏｋｅｎ-ｐｏｏｌ',
];

describe('予約語の source は POST /events の入口で 400', () => {
  it('一覧は token-pool と runner-registry を含む', () => {
    expect([...DAEMON_RESERVED_EVENT_SOURCES]).toEqual(
      expect.arrayContaining(['token-pool', 'runner-registry']),
    );
  });

  it.each(RESERVED_SPELLINGS)('POST /events（source=%j）は 400 で何も積まない', async (source) => {
    const response = await buildApp().request('/events', {
      method: 'POST',
      headers: { ...OPERATOR, ...JSON_HEADERS },
      body: JSON.stringify({ source, payload: { text: '外から' } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; code?: string };
    expect(body.code).toBe('reserved_source');
    // 値は混ぜない（固定の文だけ）。
    expect(body.error).not.toContain('token-pool');
    expect(body.error).not.toContain('runner-registry');
    expect(posted).toEqual([]);
  });

  it.each(RESERVED_SPELLINGS)(
    'POST /events/:source（パス=%j）は 400 で何も積まない',
    async (source) => {
      const response = await buildApp().request(`/events/${encodeURIComponent(source)}`, {
        method: 'POST',
        headers: { ...OPERATOR, ...JSON_HEADERS },
        body: JSON.stringify({ action: '外から' }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code?: string }).code).toBe('reserved_source');
      expect(posted).toEqual([]);
    },
  );

  it('パーセントエンコードした予約語（/events/%74oken-pool）も 400', async () => {
    const response = await buildApp().request('/events/%74oken-pool', {
      method: 'POST',
      headers: { ...OPERATOR, ...JSON_HEADERS },
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect(posted).toEqual([]);
  });

  it('添付つきでも 400 で、添付は結ばれない（添付の検査より前に断る）', async () => {
    const response = await buildApp().request('/events', {
      method: 'POST',
      headers: { ...OPERATOR, ...JSON_HEADERS },
      body: JSON.stringify({ source: 'token-pool', attachments: ['no-such-attachment'] }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code?: string }).code).toBe('reserved_source');
    expect(posted).toEqual([]);
  });

  it('普通の source は従来どおり通る（予約語を部分に含むだけの名・近い名も）', async () => {
    const app = buildApp();
    for (const source of ['ci', 'github', 'token-pool-2', 'my-runner-registry', 'token_pool']) {
      const viaBody = await app.request('/events', {
        method: 'POST',
        headers: { ...OPERATOR, ...JSON_HEADERS },
        body: JSON.stringify({ source, payload: { ok: true } }),
      });
      expect(viaBody.status, source).toBe(200);
      const viaPath = await app.request(`/events/${source}`, {
        method: 'POST',
        headers: { ...OPERATOR, ...JSON_HEADERS },
        body: JSON.stringify({ ok: true }),
      });
      expect(viaPath.status, source).toBe(200);
    }
    expect(posted.map((event) => (event.type === 'external' ? event.source : ''))).toEqual(
      ['ci', 'github', 'token-pool-2', 'my-runner-registry', 'token_pool'].flatMap((s) => [s, s]),
    );
  });
});

describe('連携の鍵は予約語の source では発行できない', () => {
  it.each(['token-pool', 'runner-registry'])(
    'source=%s の発行は 400 で、鍵は増えない',
    async (source) => {
      const response = await buildApp().request('/integration-keys', {
        method: 'POST',
        headers: { ...OPERATOR, ...JSON_HEADERS },
        body: JSON.stringify({ name: '名乗り', source }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code?: string }).code).toBe('reserved_source');
      expect(await stores.integrationKeys.listIntegrationKeys()).toEqual([]);
    },
  );

  it('普通の source の発行は従来どおり通る', async () => {
    const response = await buildApp().request('/integration-keys', {
      method: 'POST',
      headers: { ...OPERATOR, ...JSON_HEADERS },
      body: JSON.stringify({ name: 'ci', source: 'ci.main' }),
    });
    expect(response.status).toBe(200);
  });

  it('すでに在る予約語の鍵（この直しより前に発行されたもの）も、使うときに 400 で断る', async () => {
    const value = 'altk_legacy-reserved-key';
    const { sha256Hex } = await import('@alteroid/core');
    await stores.integrationKeys.putIntegrationKey({
      id: 'legacy-1',
      name: '昔の鍵',
      source: 'token-pool',
      sha256: sha256Hex(value),
      createdAt: new Date(T0).toISOString(),
      createdBy: 'operator',
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      maxBodyBytes: null,
      ratePerMinute: null,
    });
    const response = await buildApp().request('/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${value}`, ...JSON_HEADERS },
      body: JSON.stringify({ source: 'token-pool', payload: {} }),
    });
    expect(response.status).toBe(400);
    expect(posted).toEqual([]);
  });
});

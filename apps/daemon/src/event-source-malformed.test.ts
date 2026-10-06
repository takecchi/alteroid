import type { CloneHost, InboxEvent, Stores } from '@alteroid/core';
import { createAuthProviderRegistry, createAuthService, createMemoryStores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { AuthPlan } from './auth.js';

/**
 * **NUL や孤立サロゲートを含む source を、`POST /events` / `POST /events/:source` の入口で 400 で断る（#3695）。**
 *
 * 会話 id（#3573・#3640）と同じ形の穴。pg は NUL を落とし、孤立サロゲートを U+FFFD に置き換えて残すので、
 * 別々の source が1つに潰れうる。黙って正規化せず、入口で断る。**断ったら受信箱へ何も積まない・添付も結ばない。**
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

/** 本文の source（JSON）に載せる値。JSON.stringify は孤立サロゲートを `\udXXX` に直して運ぶ。 */
const BAD_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ['NUL', 'ci\u0000x'],
  ['NUL だけ', '\u0000'],
  ['上位サロゲートだけ', 'ci\ud83d'],
  ['下位サロゲートだけ', '\ude00ci'],
  ['順序が逆の対', 'a\ude00\ud83db'],
];

describe('NUL・孤立サロゲートを含む source は入口で 400', () => {
  it.each(BAD_SOURCES)('POST /events（%s）は 400 で何も積まない', async (_name, source) => {
    const response = await buildApp().request('/events', {
      method: 'POST',
      headers: { ...OPERATOR, ...JSON_HEADERS },
      body: JSON.stringify({ source, payload: { text: '外から' } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; code?: string };
    expect(body.code).toBe('invalid_source');
    // 値は混ぜない（固定の文だけ）。
    expect(body.error).not.toContain('ci');
    expect(posted).toEqual([]);
  });

  it.each(BAD_SOURCES)(
    'POST /events（%s）は添付つきでも 400 で、添付は結ばれない',
    async (_name, source) => {
      const response = await buildApp().request('/events', {
        method: 'POST',
        headers: { ...OPERATOR, ...JSON_HEADERS },
        body: JSON.stringify({ source, attachments: ['no-such-attachment'] }),
      });
      expect(response.status).toBe(400);
      // 添付の検査（attachment_missing）より前に断る。
      expect(((await response.json()) as { code?: string }).code).toBe('invalid_source');
      expect(posted).toEqual([]);
    },
  );

  // パスの source は Hono がパーセントデコードして渡す。%00 は NUL に復号されるので表せる。
  // 一方、UTF-8 の孤立サロゲート（%ED%A0%BD = U+D83D）は復号が失敗し、Hono は元の文字列
  // （`%ED%A0%BD` という普通の文字の並び）のまま渡す。つまりパスでは孤立サロゲートは表せない
  // （下のテストで、積まれる source が整形式のリテラルであることを固定する）。
  const BAD_PATHS: ReadonlyArray<readonly [string, string]> = [
    ['NUL（%00）', '/events/ci%00x'],
    ['NUL だけ', '/events/%00'],
  ];

  it.each(['/events/ci%ED%A0%BD', '/events/%ED%B8%80ci'])(
    'パスの孤立サロゲート（%s）は復号されず、整形式の文字列として通る（表せないので断る対象が無い）',
    async (path) => {
      const response = await buildApp().request(path, {
        method: 'POST',
        headers: { ...OPERATOR, ...JSON_HEADERS },
        body: '{}',
      });
      expect(response.status).toBe(200);
      const [event] = posted;
      const source = event?.type === 'external' ? event.source : '';
      expect(source).not.toBe('');
      expect(/\p{Surrogate}/u.test(source)).toBe(false); // u フラグでは、対でない（孤立した）サロゲートだけが一致する
      expect(source.includes('\u0000')).toBe(false);
    },
  );

  it.each(BAD_PATHS)('POST /events/:source（%s）は 400 で何も積まない', async (_name, path) => {
    const response = await buildApp().request(path, {
      method: 'POST',
      headers: { ...OPERATOR, ...JSON_HEADERS },
      body: JSON.stringify({ action: '外から' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; code?: string };
    expect(body.code).toBe('invalid_source');
    expect(body.error).not.toContain('ci');
    expect(posted).toEqual([]);
  });

  it('POST /events/:source は添付つきでも 400 で、添付は結ばれない', async () => {
    const response = await buildApp().request('/events/ci%00x?attachments=no-such-attachment', {
      method: 'POST',
      headers: { ...OPERATOR, ...JSON_HEADERS },
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code?: string }).code).toBe('invalid_source');
    expect(posted).toEqual([]);
  });

  it('正しいサロゲート対（絵文字）と普通の source は従来どおり通る', async () => {
    const app = buildApp();
    const sources = ['ci', 'github.main', 'ci-😀', '日本語'];
    for (const source of sources) {
      const viaBody = await app.request('/events', {
        method: 'POST',
        headers: { ...OPERATOR, ...JSON_HEADERS },
        body: JSON.stringify({ source, payload: { ok: true } }),
      });
      expect(viaBody.status, source).toBe(200);
      const viaPath = await app.request(`/events/${encodeURIComponent(source)}`, {
        method: 'POST',
        headers: { ...OPERATOR, ...JSON_HEADERS },
        body: JSON.stringify({ ok: true }),
      });
      expect(viaPath.status, source).toBe(200);
    }
    expect(posted.map((event) => (event.type === 'external' ? event.source : ''))).toEqual(
      sources.flatMap((s) => [s, s]),
    );
  });
});

describe('連携の鍵の source は、パターンで NUL・サロゲートを通さない（変えない）', () => {
  it.each([
    ['NUL', 'ci\u0000x'],
    ['上位サロゲートだけ', 'ci\ud83d'],
    ['下位サロゲートだけ', '\ude00ci'],
    ['絵文字（対）', 'ci-😀'],
  ])('source=%s の発行は 400 で、鍵は増えない', async (_name, source) => {
    const response = await buildApp().request('/integration-keys', {
      method: 'POST',
      headers: { ...OPERATOR, ...JSON_HEADERS },
      body: JSON.stringify({ name: 'x', source }),
    });
    expect(response.status).toBe(400);
    expect(await stores.integrationKeys.listIntegrationKeys()).toEqual([]);
  });
});

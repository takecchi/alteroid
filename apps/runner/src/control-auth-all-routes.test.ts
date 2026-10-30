import { createHash } from 'node:crypto';

import type { RunnerHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';
import { appDefaults } from './app-defaults.test-support.js';

const TOKEN = 'daemon-only-token-all-routes';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

// 鍵なしでよい経路はこれだけ。増やすなら、なぜ無認証でよいかを先に言えること。
const UNAUTHENTICATED = new Set(['GET /livez']);

// 鍵なしの呼びが host に触れたら、その経路は門の内側へ入っている。触れたものの名前を残す。
function untouchableHost() {
  const touched: string[] = [];
  const host = new Proxy(
    {},
    {
      get(_target, property) {
        touched.push(String(property));
        return () => {
          throw new Error(`host.${String(property)} は鍵なしで呼ばれてはならない`);
        };
      },
    },
  ) as RunnerHost;
  return { host, touched };
}

function appWith(host: RunnerHost) {
  return createRunnerApp({
    host,
    outbox: new Outbox(),
    tokenSha256: TOKEN_SHA256,
    ...appDefaults(),
  });
}

// 登録された経路を app 自身から引く（手で並べない）。`ALL` は `use` の門で、経路そのものではない。
// 1つの経路が bodyLimit・validator・本体で複数行になるので、メソッドと経路の組で畳む。
function registeredRoutes(app: ReturnType<typeof appWith>) {
  const pairs = new Set<string>();
  for (const route of app.routes) {
    if (route.method === 'ALL') continue;
    pairs.add(`${route.method} ${route.path}`);
  }
  return [...pairs].sort().map((pair) => {
    const [method = '', path = ''] = pair.split(' ');
    return { pair, method, path, url: path.replace(/:[A-Za-z]+/g, 'x') };
  });
}

describe('runner の制御面は、登録されたすべての経路で鍵を求める', () => {
  const routes = registeredRoutes(appWith(untouchableHost().host));

  it('経路を引けている（空の列挙で全件緑にならない）', () => {
    expect(routes.length).toBeGreaterThanOrEqual(20);
    expect(routes.map((r) => r.pair)).toContain('GET /livez');
    expect(routes.map((r) => r.pair)).toContain('GET /managers/:id/archive/:archiveId');
  });

  const guarded = routes.filter((r) => !UNAUTHENTICATED.has(r.pair));

  it.each(guarded.map((r) => [r.pair, r] as const))(
    '%s: 鍵なしは 401 で、host に触れない',
    async (_pair, route) => {
      const { host, touched } = untouchableHost();
      const response = await appWith(host).request(route.url, { method: route.method });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
      expect(touched).toEqual([]);
    },
  );

  it.each(guarded.map((r) => [r.pair, r] as const))(
    '%s: 違う鍵も 401 で、host に触れない',
    async (_pair, route) => {
      const { host, touched } = untouchableHost();
      const response = await appWith(host).request(route.url, {
        method: route.method,
        headers: { authorization: 'Bearer not-the-token' },
      });
      expect(response.status).toBe(401);
      expect(touched).toEqual([]);
    },
  );

  it('`/livez` は鍵なしで通る', async () => {
    const { host } = untouchableHost();
    const response = await appWith(host).request('/livez');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('正しい鍵なら門を通る（代表: GET /managers）', async () => {
    const host = { noteDaemonContact: () => undefined, list: () => [] } as unknown as RunnerHost;
    const response = await appWith(host).request('/managers', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ managers: [] });
  });
});

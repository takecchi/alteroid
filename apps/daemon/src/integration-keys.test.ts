import type { CloneHost, InboxEvent, Stores } from '@alteroid/core';
import {
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  createMemoryStores,
  sha256Hex,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { AuthPlan } from './auth.js';
import { createFixedWindowRateLimiter, judgeIntegrationRoute } from './integration-gate.js';

/**
 * **連携の鍵（`altk_`）— 第3の資格**（#3113 段1）。
 *
 * 守るもの: ①未知・失効・期限切れは 401 ②通るのは固定の1 source の外部イベントの口だけで、それ以外は
 * **すべて 403**（既定で拒否。openapi の全ルートを回して確かめる）③上限（413・429・Retry-After）は
 * この資格にだけ掛かる ④認証が無効の構成でも `altk_` には制限が掛かる ⑤値は発行の応答にしか出ない
 * ⑥日誌が書けなければ発行も失効も状態を変えない。**時計は偽物で、実時間は待たない。**
 */

const OPERATOR = { authorization: 'Bearer test-token' };
const JSON_HEADERS = { 'content-type': 'application/json' };
const T0 = Date.parse('2026-06-01T00:00:00.000Z');

let nowMs = T0;
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
    // `GET /topology` が読む分（#3676 の稼働状況の図の歯）。
    usageBlocked: false,
    managers: { list: () => Promise.resolve([]) },
  } as unknown as CloneHost;
}

function planOf(enabled: boolean): AuthPlan {
  return {
    enabled,
    providers: [],
    publicBaseUrl: 'http://127.0.0.1:4517',
    tokenTtlDays: 30,
    description: 'テスト',
  };
}

function buildApp(options: { enabled?: boolean; stores?: Stores } = {}) {
  const used = options.stores ?? stores;
  const plan = planOf(options.enabled ?? true);
  return createApp({
    clone: fakeClone(),
    stores: used,
    token: 'test-token',
    shutdown: () => undefined,
    now: () => new Date(nowMs),
    journalEvents: { subscribe: () => () => undefined },
    auth: {
      plan,
      service: createAuthService({
        store: used.auth,
        providers: createAuthProviderRegistry([]),
      }),
    },
  });
}

type App = ReturnType<typeof buildApp>;

async function issue(
  app: App,
  input: Record<string, unknown> = {},
): Promise<{ id: string; value: string }> {
  const response = await app.request('/integration-keys', {
    method: 'POST',
    headers: { ...OPERATOR, ...JSON_HEADERS },
    body: JSON.stringify({ name: 'ci の鍵', source: 'ci.main', ...input }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { key: { id: string }; value: string };
  return { id: body.key.id, value: body.value };
}

const bearer = (value: string) => ({ authorization: `Bearer ${value}` });
const events = (source: string, extra: Record<string, unknown> = {}) => ({
  method: 'POST',
  headers: JSON_HEADERS,
  body: JSON.stringify({ source, payload: { status: 'failure' }, ...extra }),
});

beforeEach(() => {
  nowMs = T0;
  stores = createMemoryStores();
  posted = [];
});

describe('連携の鍵の発行・一覧・失効', () => {
  it('発行の応答だけが値を返し、一覧・日誌・stderr には値もハッシュ全体も出ない', async () => {
    const app = buildApp();
    const lines = await captureStderr(async () => {
      const { id, value } = await issue(app, { name: 'ビルド', source: 'ci.main' });
      expect(value).toMatch(/^altk_[A-Za-z0-9_-]{43}$/);
      const sha = sha256Hex(value);

      const list = await app.request('/integration-keys', { headers: OPERATOR });
      const listText = await list.text();
      expect(list.status).toBe(200);
      expect(listText).not.toContain(value);
      expect(listText).not.toContain(sha);
      const keys = (JSON.parse(listText) as { keys: Record<string, unknown>[] }).keys;
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({
        id,
        name: 'ビルド',
        source: 'ci.main',
        fingerprint: sha.slice(0, 12),
        createdBy: '実行環境の持ち主による操作',
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        limits: { maxBodyBytes: 1024 * 1024, ratePerMinute: 60 },
      });

      // 失効・断った試み（stderr に出る）まで通してから、日誌と stderr を調べる。
      await app.request('/events/ci.main', {
        ...events('ci.main'),
        headers: bearer('altk_unknown'),
      });
      await app.request('/events', {
        ...events('ci.main'),
        headers: { ...bearer(value), ...JSON_HEADERS },
      });
      await app.request(`/integration-keys/${id}/revoke`, {
        method: 'POST',
        headers: { ...OPERATOR, ...JSON_HEADERS },
        body: '{}',
      });
      const journal = JSON.stringify(await stores.journal.list());
      expect(journal).not.toContain(value);
      expect(journal).not.toContain(sha);
      expect(journal).toContain('連携の鍵を発行');
      expect(journal).toContain(sha.slice(0, 12));
      expect(journal).toContain('連携の鍵を失効');
      // 後で stderr を調べるために値を持ち出す。
      (globalThis as { __altkTest?: string }).__altkTest = value;
    });
    const value = (globalThis as { __altkTest?: string }).__altkTest ?? '';
    expect(value).not.toBe('');
    expect(lines.join('\n')).not.toContain(value);
    expect(lines.join('\n')).toContain('連携の鍵の要求を断った（401');
  });

  it('入力の形が不正なら 400（source の形・過去の期限・空の名前）で、何も作らない', async () => {
    const app = buildApp();
    for (const bad of [
      { source: 'CI Main' },
      { source: '' },
      { source: 'a'.repeat(65) },
      { name: '   ' },
      { expiresAt: '2026-05-01T00:00:00.000Z' },
      { maxBodyBytes: 0 },
      { ratePerMinute: -1 },
    ]) {
      const response = await app.request('/integration-keys', {
        method: 'POST',
        headers: { ...OPERATOR, ...JSON_HEADERS },
        body: JSON.stringify({ name: 'x', source: 'ci', ...bad }),
      });
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await stores.integrationKeys.listIntegrationKeys()).toEqual([]);
  });

  it('許可済みのアカウントも発行できる（createdBy にそのアカウントが残る）。失効は冪等', async () => {
    const app = buildApp();
    await stores.auth.putAccount({
      id: 'acct-1',
      displayName: 'owner',
      email: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
      grantedAt: '2026-01-01T00:00:00.000Z',
      grantedBy: 'operator',
      ownerDeclaredAt: null,
    });
    await stores.auth.putAccessToken({
      id: 'tok-1',
      accountId: 'acct-1',
      sha256: sha256Hex('alt_account-token'),
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
    const created = await app.request('/integration-keys', {
      method: 'POST',
      headers: { ...bearer('alt_account-token'), ...JSON_HEADERS },
      body: JSON.stringify({ name: 'k', source: 'ci' }),
    });
    expect(created.status).toBe(200);
    const { key } = (await created.json()) as { key: { id: string; createdBy: string } };
    expect(key.createdBy).toContain('acct-1');

    const revoke = () =>
      app.request(`/integration-keys/${key.id}/revoke`, {
        method: 'POST',
        headers: { ...bearer('alt_account-token'), ...JSON_HEADERS },
        body: '{}',
      });
    const first = (await (await revoke()).json()) as { key: { revokedAt: string } };
    nowMs += 5000;
    const second = (await (await revoke()).json()) as { key: { revokedAt: string } };
    expect(second.key.revokedAt).toBe(first.key.revokedAt);
    const journal = await stores.journal.list();
    expect(
      journal.filter((e) => e.type === 'decision' && e.decision.includes('連携の鍵を失効')),
    ).toHaveLength(1);
    const missing = await app.request('/integration-keys/nope/revoke', {
      method: 'POST',
      headers: { ...OPERATOR, ...JSON_HEADERS },
      body: '{}',
    });
    expect(missing.status).toBe(404);
  });
});

describe('門番: 鍵の照合（401）', () => {
  it('未知の鍵・失効した鍵・期限切れの鍵は 401', async () => {
    const app = buildApp();
    const live = await issue(app);
    const revoked = await issue(app, { name: '失効させる' });
    const expiring = await issue(app, {
      name: '期限つき',
      expiresAt: new Date(T0 + 60_000).toISOString(),
    });

    // 陽性対照: 生きている鍵・期限内の鍵は通る。
    expect(
      (
        await app.request('/events', {
          ...events('ci.main'),
          headers: { ...bearer(live.value), ...JSON_HEADERS },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request('/events', {
          ...events('ci.main'),
          headers: { ...bearer(expiring.value), ...JSON_HEADERS },
        })
      ).status,
    ).toBe(200);

    await app.request(`/integration-keys/${revoked.id}/revoke`, {
      method: 'POST',
      headers: { ...OPERATOR, ...JSON_HEADERS },
      body: '{}',
    });
    nowMs += 61_000;

    const attempt = (value: string) =>
      app.request('/events', {
        ...events('ci.main'),
        headers: { ...bearer(value), ...JSON_HEADERS },
      });
    await captureStderr(async () => {
      expect((await attempt('altk_' + 'A'.repeat(43))).status).toBe(401);
      expect((await attempt(revoked.value)).status).toBe(401);
      expect((await attempt(expiring.value)).status).toBe(401);
    });
    // 陰性対照: 同じ時刻で、生きている鍵は通る。
    expect((await attempt(live.value)).status).toBe(200);
  });

  it('使うと lastUsedAt が付く（間引きは60秒）', async () => {
    const app = buildApp();
    const { id, value } = await issue(app);
    const send = () =>
      app.request('/events', {
        ...events('ci.main'),
        headers: { ...bearer(value), ...JSON_HEADERS },
      });
    await send();
    const first = (await stores.integrationKeys.getIntegrationKey(id))?.lastUsedAt;
    expect(first).toBe(new Date(T0).toISOString());
    nowMs += 10_000;
    await send();
    expect((await stores.integrationKeys.getIntegrationKey(id))?.lastUsedAt).toBe(first);
    nowMs += 60_000;
    await send();
    expect((await stores.integrationKeys.getIntegrationKey(id))?.lastUsedAt).toBe(
      new Date(nowMs).toISOString(),
    );
  });
});

describe('門番: 既定で拒否（403）', () => {
  it('source が一致する POST /events・POST /events/:source だけ通り、載った事象に via が付く', async () => {
    const app = buildApp();
    const { id, value } = await issue(app, { name: 'ビルド', source: 'ci.main' });
    const h = { ...bearer(value), ...JSON_HEADERS };

    const ok = await app.request('/events', { ...events('ci.main'), headers: h });
    expect(ok.status).toBe(200);
    const okPath = await app.request('/events/ci.main', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ any: 'shape' }),
    });
    expect(okPath.status).toBe(200);
    expect(posted).toHaveLength(2);
    for (const event of posted) {
      expect(event).toMatchObject({
        type: 'external',
        source: 'ci.main',
        via: { keyId: id, name: 'ビルド' },
      });
    }
    // 人間の経路には via が付かない。
    await app.request('/events', {
      ...events('anything'),
      headers: { ...OPERATOR, ...JSON_HEADERS },
    });
    expect((posted[2] as { via?: unknown }).via).toBeUndefined();
    // 本文から via を立てられない。
    await app.request('/events', {
      ...events('ci.main', { via: { keyId: 'forged', name: 'forged' } }),
      headers: h,
    });
    expect((posted[3] as { via: { keyId: string } }).via.keyId).toBe(id);

    const before = posted.length;
    await captureStderr(async () => {
      // source の不一致（本文・パス）は 403。パスのエンコード違いでも一致しない別名は通らない。
      expect((await app.request('/events', { ...events('ci.other'), headers: h })).status).toBe(
        403,
      );
      expect(
        (await app.request('/events/ci.other', { method: 'POST', headers: h, body: '{}' })).status,
      ).toBe(403);
      expect(
        (await app.request('/events/ci.main/extra', { method: 'POST', headers: h, body: '{}' }))
          .status,
      ).toBe(403);
      expect(
        (await app.request('/events/%E0%A4%A', { method: 'POST', headers: h, body: '{}' })).status,
      ).toBe(403);
      // メソッド違い。
      expect((await app.request('/events', { headers: bearer(value) })).status).toBe(403);
    });
    expect(posted).toHaveLength(before);
    // 断った試みは日誌に書かない。
    const journal = JSON.stringify(await stores.journal.list());
    expect(journal).not.toContain('ci.other');
  });

  it('openapi の全ルートを回す: 連携の鍵で通るのは source 一致の2口と添付のアップロード（POST /attachments）だけで、残りはすべて 403', async () => {
    const app = buildApp();
    const { value } = await issue(app, { source: 'ci.main' });
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const methods = ['get', 'post', 'put', 'delete', 'patch'];
    const routes = Object.entries(spec.paths).flatMap(([path, item]) =>
      methods.filter((m) => m in item).map((method) => ({ method, path })),
    );
    // 列挙が空振りしていない（陽性対照の前提）。
    expect(routes.length).toBeGreaterThan(80);
    expect(routes).toContainEqual({ method: 'post', path: '/events' });
    expect(routes).toContainEqual({ method: 'post', path: '/events/{source}' });
    expect(routes).toContainEqual({ method: 'post', path: '/attachments' });
    expect(routes).toContainEqual({ method: 'get', path: '/attachments/{id}' });
    expect(routes).toContainEqual({ method: 'get', path: '/attachments/{id}/meta' });
    expect(routes).toContainEqual({ method: 'post', path: '/integration-keys' });
    expect(routes).toContainEqual({ method: 'post', path: '/integration-keys/{id}/revoke' });

    const isPublic = (path: string) =>
      path === '/health' ||
      path === '/openapi.json' ||
      path === '/docs' ||
      (path.startsWith('/auth/') && path !== '/auth/me' && path !== '/auth/logout');

    const wrongly: string[] = [];
    const denied: string[] = [];
    const passedGate: string[] = [];
    await captureStderr(async () => {
      for (const { method, path } of routes) {
        if (isPublic(path)) continue;
        const url = path.replace(/\{[^}]+\}/g, 'x');
        const hasBody = method !== 'get' && method !== 'delete';
        const response = await app.request(url, {
          method: method.toUpperCase(),
          headers: { ...bearer(value), ...JSON_HEADERS },
          // 本文のある口へは「別の source」を名乗る本文を送る（`POST /events` が 403 になることの確認）。
          ...(hasBody ? { body: JSON.stringify({ source: 'other.src' }) } : {}),
        });
        // `POST /events/{source}` はパスの `x` が鍵の source（ci.main）と違うので 403。
        // `POST /attachments` は門を通る（ここでは content-type が octet-stream でないので、その口自身の 415 で
        // 止まる。**403 でないこと**が「門を通った」の証拠）。
        if (response.status === 403) denied.push(`${method} ${path}`);
        else if (method === 'post' && path === '/attachments' && response.status === 415) {
          passedGate.push(`${method} ${path}`);
        } else wrongly.push(`${method} ${path} -> ${String(response.status)}`);
      }
    });
    expect(wrongly).toEqual([]);
    expect(passedGate).toEqual(['post /attachments']);
    // 添付の読み出しは鍵には開かない（上げるだけで、読めない）。
    expect(denied).toContain('get /attachments/{id}');
    expect(denied).toContain('get /attachments/{id}/meta');
    expect(denied).toContain('post /events/{source}');
    expect(denied).toContain('get /integration-keys');
    expect(denied).toContain('post /integration-keys');
    expect(denied.length + passedGate.length).toBe(
      routes.filter(({ path }) => !isPublic(path)).length,
    );
  });

  it('陰性対照: 同じ口は持ち主（operator）には開いている（403 は鍵の資格が理由）', async () => {
    const app = buildApp();
    for (const path of ['/integration-keys', '/access', '/status']) {
      const response = await app.request(path, { headers: OPERATOR });
      expect(response.status, path).toBe(200);
    }
    const { value } = await issue(app);
    for (const path of ['/integration-keys', '/access', '/status']) {
      expect((await app.request(path, { headers: bearer(value) })).status, path).toBe(403);
    }
    // 鍵の管理の口は、鍵では叩けない（鍵が鍵を発行・失効できない）。
    const created = await app.request('/integration-keys', {
      method: 'POST',
      headers: { ...bearer(value), ...JSON_HEADERS },
      body: JSON.stringify({ name: 'x', source: 'ci.main' }),
    });
    expect(created.status).toBe(403);
    expect(await stores.integrationKeys.listIntegrationKeys()).toHaveLength(1);
  });

  it('公開パスの扱いは今のまま（認証が有効でも /health は鍵の有無に関わらず通る）', async () => {
    const app = buildApp();
    const { value } = await issue(app);
    expect((await app.request('/health', { headers: bearer(value) })).status).toBe(200);
    expect((await app.request('/health', { headers: bearer('altk_unknown') })).status).toBe(200);
  });
});

describe('上限は連携の鍵にだけ掛かる（413・429・Retry-After）', () => {
  it('本文が鍵の maxBodyBytes を超えたら 413（Content-Length の有無どちらでも）。既定は 1 MiB', async () => {
    const app = buildApp();
    const small = await issue(app, { name: '小さい', maxBodyBytes: 100 });
    const h = { ...bearer(small.value), ...JSON_HEADERS };
    const big = JSON.stringify({ source: 'ci.main', payload: 'x'.repeat(200) });
    await captureStderr(async () => {
      expect((await app.request('/events', { method: 'POST', headers: h, body: big })).status).toBe(
        413,
      );
      expect(
        (
          await app.request('/events', {
            method: 'POST',
            headers: { ...h, 'content-length': String(big.length) },
            body: big,
          })
        ).status,
      ).toBe(413);
    });
    expect(posted).toHaveLength(0);
    // 陽性対照: 上限内は通る。
    expect((await app.request('/events', { ...events('ci.main'), headers: h })).status).toBe(200);

    const def = await issue(app, { name: '既定' });
    const dh = { ...bearer(def.value), ...JSON_HEADERS };
    const pad = (n: number) => JSON.stringify({ source: 'ci.main', payload: 'x'.repeat(n) });
    const overhead = pad(0).length;
    expect(
      (
        await app.request('/events', {
          method: 'POST',
          headers: dh,
          body: pad(1024 * 1024 - overhead),
        })
      ).status,
    ).toBe(200);
    await captureStderr(async () => {
      expect(
        (
          await app.request('/events', {
            method: 'POST',
            headers: dh,
            body: pad(1024 * 1024 - overhead + 1),
          })
        ).status,
      ).toBe(413);
    });
  });

  it('人間・operator の経路には新しい上限が無い（2 MiB の本文も 70 回の連投も通る）', async () => {
    const app = buildApp();
    const h = { ...OPERATOR, ...JSON_HEADERS };
    const huge = JSON.stringify({ source: 'ci.main', payload: 'x'.repeat(2 * 1024 * 1024) });
    expect((await app.request('/events', { method: 'POST', headers: h, body: huge })).status).toBe(
      200,
    );
    for (let i = 0; i < 70; i += 1) {
      expect((await app.request('/events', { ...events('ci.main'), headers: h })).status).toBe(200);
    }
  });

  it('鍵ごとの固定窓: ratePerMinute を超えたら 429 と Retry-After、窓が替われば通る（偽の時計）', async () => {
    const app = buildApp();
    const limited = await issue(app, { name: '3回', ratePerMinute: 3 });
    const other = await issue(app, { name: '別の鍵', source: 'ci.other' });
    const send = (value: string, source = 'ci.main') =>
      app.request('/events', { ...events(source), headers: { ...bearer(value), ...JSON_HEADERS } });

    nowMs = T0 + 20_000; // 窓の 20 秒目
    for (let i = 0; i < 3; i += 1) expect((await send(limited.value)).status).toBe(200);
    await captureStderr(async () => {
      const over = await send(limited.value);
      expect(over.status).toBe(429);
      expect(over.headers.get('retry-after')).toBe('40');
      nowMs = T0 + 59_000;
      expect((await send(limited.value)).headers.get('retry-after')).toBe('1');
    });
    // 他の鍵は数えを共有しない。
    expect((await send(other.value, 'ci.other')).status).toBe(200);
    // 次の窓。
    nowMs = T0 + 60_000;
    expect((await send(limited.value)).status).toBe(200);
    expect(posted.filter((e) => e.type === 'external' && e.source === 'ci.main')).toHaveLength(4);
  });

  it('既定は 60 回/分', async () => {
    const app = buildApp();
    const { value } = await issue(app);
    const send = () =>
      app.request('/events', {
        ...events('ci.main'),
        headers: { ...bearer(value), ...JSON_HEADERS },
      });
    for (let i = 0; i < 60; i += 1) expect((await send()).status).toBe(200);
    await captureStderr(async () => {
      expect((await send()).status).toBe(429);
    });
  });
});

describe('認証が無効の構成でも altk_ には照合と制限が掛かる', () => {
  it('bearer 無しは今までどおり素通し。altk_ は照合され、既定で拒否され、上限が掛かる', async () => {
    const app = buildApp({ enabled: false });
    // 無効の構成でも発行できる（素通しの operator 扱い）。本文の source 違いの 403 と 413 になった試みも回数に数える（4回のうち2回）。
    const { value } = await issue(app, { name: '無効構成', maxBodyBytes: 100, ratePerMinute: 4 });

    // bearer 無し: 素通し（今までどおり）。
    expect((await app.request('/status')).status).toBe(200);
    expect((await app.request('/events', events('anything'))).status).toBe(200);

    const h = { ...bearer(value), ...JSON_HEADERS };
    await captureStderr(async () => {
      expect((await app.request('/status', { headers: bearer(value) })).status).toBe(403);
      expect((await app.request('/events', { ...events('ci.other'), headers: h })).status).toBe(
        403,
      );
      expect(
        (
          await app.request('/events', {
            ...events('ci.main'),
            headers: { ...bearer('altk_unknown'), ...JSON_HEADERS },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await app.request('/events', {
            method: 'POST',
            headers: h,
            body: JSON.stringify({ source: 'ci.main', payload: 'x'.repeat(300) }),
          })
        ).status,
      ).toBe(413);
    });
    expect((await app.request('/events', { ...events('ci.main'), headers: h })).status).toBe(200);
    expect((await app.request('/events', { ...events('ci.main'), headers: h })).status).toBe(200);
    await captureStderr(async () => {
      expect((await app.request('/events', { ...events('ci.main'), headers: h })).status).toBe(429);
    });
  });
});

describe('日誌が書けなければ、状態を変えず 500', () => {
  it('発行: 日誌が落ちたら 500（journal_write_failed）で、鍵は1本も増えない', async () => {
    const failing: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: () => Promise.reject(new Error('journal down (test)')),
      },
    };
    const app = buildApp({ stores: failing });
    let response: Response | undefined;
    await captureStderr(async () => {
      response = await app.request('/integration-keys', {
        method: 'POST',
        headers: { ...OPERATOR, ...JSON_HEADERS },
        body: JSON.stringify({ name: 'x', source: 'ci' }),
      });
    });
    expect(response?.status).toBe(500);
    expect(await response?.json()).toMatchObject({ code: 'journal_write_failed' });
    expect(await stores.integrationKeys.listIntegrationKeys()).toEqual([]);
  });

  it('失効: 日誌が落ちたら 500 で、鍵は失効せず使える', async () => {
    const healthy = buildApp();
    const { id, value } = await issue(healthy);
    const failing: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: () => Promise.reject(new Error('journal down (test)')),
      },
    };
    const app = buildApp({ stores: failing });
    let response: Response | undefined;
    await captureStderr(async () => {
      response = await app.request(`/integration-keys/${id}/revoke`, {
        method: 'POST',
        headers: { ...OPERATOR, ...JSON_HEADERS },
        body: '{}',
      });
    });
    expect(response?.status).toBe(500);
    expect((await stores.integrationKeys.getIntegrationKey(id))?.revokedAt).toBeNull();
    expect(
      (
        await healthy.request('/events', {
          ...events('ci.main'),
          headers: { ...bearer(value), ...JSON_HEADERS },
        })
      ).status,
    ).toBe(200);
  });
});

describe('稼働状況の図の外部サービスの線（#3676）', () => {
  type TopologyBody = {
    externals?: { keyId: string; name: string; source: string; lastAt: string }[];
    links: { key: string; lastDownAt?: string; lastUpAt?: string; lastActivityAt?: string }[];
  };
  const topology = async (app: App): Promise<TopologyBody> =>
    (await (await app.request('/topology', { headers: OPERATOR })).json()) as TopologyBody;

  it('連携の鍵で POST /events を受け付けた時点で、クローンが取り出す前に外部→クローンの線が down で光る', async () => {
    const app = buildApp();
    const { id, value } = await issue(app, { name: 'ビルド', source: 'ci.main' });
    const accepted = await app.request('/events', {
      ...events('ci.main'),
      headers: { ...bearer(value), ...JSON_HEADERS },
    });
    expect(accepted.status).toBe(200);
    // 偽のクローンは日誌に何も書かない（取り出していない）。それでも受け付けた時刻
    // （受信箱へ積んだ event.at と同じ値）で光る。
    expect(posted).toHaveLength(1);
    const at = posted[0]!.at;
    const body = await topology(app);
    expect(body.externals).toEqual([{ keyId: id, name: 'ビルド', source: 'ci.main', lastAt: at }]);
    expect(body.links).toContainEqual({ key: `external:${id}~clone`, lastDownAt: at });
  });

  it('POST /events/:source でも光る。source 違いで断った呼び出しと、鍵を使わない送信は光らない', async () => {
    const app = buildApp();
    const { id, value } = await issue(app, { name: 'ビルド', source: 'ci.main' });
    const refused = await app.request('/events', {
      ...events('other'),
      headers: { ...bearer(value), ...JSON_HEADERS },
    });
    expect(refused.status).toBe(403);
    const byOperator = await app.request('/events', {
      ...events('ci.main'),
      headers: { ...OPERATOR, ...JSON_HEADERS },
    });
    expect(byOperator.status).toBe(200);
    const before = await topology(app);
    expect(before.externals).toBeUndefined();
    expect(before.links.filter((l) => l.key.startsWith('external'))).toEqual([]);

    const accepted = await app.request('/events/ci.main', {
      ...events('ci.main'),
      headers: { ...bearer(value), ...JSON_HEADERS },
    });
    expect(accepted.status).toBe(200);
    // 受信箱には operator の分と鍵の分の2件。光るのは鍵の分の時刻だけ。
    expect(posted).toHaveLength(2);
    const after = await topology(app);
    expect(after.links).toContainEqual({
      key: `external:${id}~clone`,
      lastDownAt: posted[1]!.at,
    });
  });
});

describe('部品', () => {
  it('judgeIntegrationRoute: 通すのは POST /events・source 一致の POST /events/:source・添付のアップロード POST /attachments だけ', () => {
    expect(judgeIntegrationRoute('POST', '/attachments', 'ci')).toEqual({
      allowed: true,
      via: 'attachment-upload',
    });
    expect(judgeIntegrationRoute('POST', '/events', 'ci')).toEqual({
      allowed: true,
      via: 'body-source',
    });
    expect(judgeIntegrationRoute('POST', '/events/ci', 'ci')).toEqual({
      allowed: true,
      via: 'path-source',
    });
    expect(judgeIntegrationRoute('POST', '/events/c%69', 'ci')).toEqual({
      allowed: true,
      via: 'path-source',
    });
    for (const [method, path] of [
      ['GET', '/events'],
      ['POST', '/events/'],
      ['POST', '/events/other'],
      ['POST', '/events/ci/x'],
      ['POST', '/events/%'],
      ['POST', '/event'],
      ['POST', '/integration-keys'],
      ['PUT', '/events/ci'],
      // 添付は上げるだけ。読み出し・ほかの形は通さない。
      ['GET', '/attachments'],
      ['GET', '/attachments/x'],
      ['GET', '/attachments/x/meta'],
      ['POST', '/attachments/'],
      ['POST', '/attachments/x'],
      ['PUT', '/attachments'],
    ] as const) {
      expect(judgeIntegrationRoute(method, path, 'ci'), `${method} ${path}`).toEqual({
        allowed: false,
      });
    }
  });

  it('固定窓: 窓が替われば数え直し、Retry-After は窓の残り秒（偽の時計）', () => {
    let t = 0;
    const limiter = createFixedWindowRateLimiter(() => t);
    expect(limiter.consume('k', 2)).toEqual({ ok: true });
    expect(limiter.consume('k', 2)).toEqual({ ok: true });
    t = 1_500;
    expect(limiter.consume('k', 2)).toEqual({ ok: false, retryAfterSeconds: 59 });
    t = 60_000;
    expect(limiter.consume('k', 2)).toEqual({ ok: true });
  });
});

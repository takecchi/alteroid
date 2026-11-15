import type { CloneHost, Stores } from '@alteroid/core';
import {
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  createMemoryStores,
  fakeCloneHost,
  sha256Hex,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { AuthPlan } from './auth.js';
import { READ_TOKEN_ALLOWED_ROUTES, judgeReadTokenRoute } from './read-token-gate.js';

const OPERATOR = { authorization: 'Bearer test-token' };
const JSON_HEADERS = { 'content-type': 'application/json' };
const MCP_HEADERS = { ...JSON_HEADERS, accept: 'application/json, text/event-stream' };
const T0 = Date.parse('2026-11-15T00:00:00.000Z');
const DAY_MS = 86_400_000;

const bearer = (value: string) => ({ authorization: `Bearer ${value}` });
const LOGIN_ALICE = 'alt_alice-login-token';
const LOGIN_BOB = 'alt_bob-login-token';

let nowMs = T0;
let stores: Stores;

function fakeClone(): CloneHost {
  return fakeCloneHost({
    post: () => 'conversation-1',
    postPersisted: () => Promise.resolve('persisted' as const),
    subscribe: () => () => undefined,
    stop: () => Promise.resolve(),
    usageBlocked: false,
    managers: {
      list: () => Promise.resolve([]),
      listWithUnreadable: () => Promise.resolve({ managers: [], unreadable: [] }),
    },
  } as unknown as Partial<CloneHost>);
}

const PLAN: AuthPlan = {
  enabled: true,
  providers: [],
  publicBaseUrl: 'http://127.0.0.1:4517',
  tokenTtlDays: 30,
  description: 'テスト',
};

function authServiceOf(used: Stores) {
  return createAuthService({
    store: used.auth,
    providers: createAuthProviderRegistry([]),
    now: () => new Date(nowMs),
  });
}

function buildApp(used: Stores = stores) {
  return createApp({
    clone: fakeClone(),
    stores: used,
    token: 'test-token',
    shutdown: () => undefined,
    now: () => new Date(nowMs),
    journalEvents: { subscribe: () => () => undefined },
    auth: { plan: PLAN, service: authServiceOf(used) },
  });
}
type App = ReturnType<typeof buildApp>;

async function putAccount(id: string, granted = true): Promise<void> {
  await stores.auth.putAccount({
    id,
    displayName: id,
    email: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    grantedAt: granted ? '2026-01-01T00:00:00.000Z' : null,
    grantedBy: granted ? 'operator' : null,
  });
}

async function putLoginToken(accountId: string, id: string, value: string): Promise<void> {
  await stores.auth.putAccessToken({
    id,
    accountId,
    sha256: sha256Hex(value),
    label: 'laptop',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    kind: 'full',
    origin: 'login',
    issuedBy: null,
  });
}

interface TokenView {
  id: string;
  accountId: string;
  name: string;
  kind: string;
  origin: string;
  issuedBy: string | null;
  fingerprint: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

async function issue(
  app: App,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ status: number; json: { token?: TokenView; value?: string; error?: string } }> {
  const response = await app.request('/access-tokens', {
    method: 'POST',
    headers: { ...headers, ...JSON_HEADERS },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as never };
}

async function revoke(app: App, headers: Record<string, string>, id: string, query = '') {
  return app.request(`/access-tokens/${id}/revoke${query}`, {
    method: 'POST',
    headers: { ...headers, ...JSON_HEADERS },
    body: '{}',
  });
}

// アカウントの資格（ログインのトークン）で発行して、値を返す
async function issuedValue(
  app: App,
  kind: 'read' | 'full',
  login = LOGIN_ALICE,
): Promise<{ value: string; id: string }> {
  const result = await issue(app, bearer(login), { name: `${kind} の鍵`, kind });
  expect(result.status).toBe(200);
  return { value: result.json.value ?? '', id: result.json.token?.id ?? '' };
}

beforeEach(async () => {
  nowMs = T0;
  stores = createMemoryStores();
  await putAccount('alice');
  await putAccount('bob');
  await putAccount('carol', false);
  await putLoginToken('alice', 'tok-alice', LOGIN_ALICE);
  await putLoginToken('bob', 'tok-bob', LOGIN_BOB);
});

describe('POST /access-tokens: 発行', () => {
  it('アカウントの資格は自分に発行でき、既定は read・期限 30 日。値は応答でだけ返り、一覧・日誌・stderr に値もハッシュ全体も出ない', async () => {
    const app = buildApp();
    let value = '';
    const lines = await captureStderr(async () => {
      const result = await issue(app, bearer(LOGIN_ALICE), { name: '別の環境' });
      expect(result.status).toBe(200);
      value = result.json.value ?? '';
      expect(value).toMatch(/^alt_/);
      expect(result.json.token).toMatchObject({
        accountId: 'alice',
        name: '別の環境',
        kind: 'read',
        origin: 'issued',
        issuedBy: 'alice',
        expiresAt: new Date(T0 + 30 * DAY_MS).toISOString(),
        revokedAt: null,
        fingerprint: sha256Hex(value).slice(0, 12),
      });

      const list = await app.request('/access-tokens', { headers: bearer(LOGIN_ALICE) });
      const listText = await list.text();
      expect(list.status).toBe(200);
      expect(listText).not.toContain(value);
      expect(listText).not.toContain(sha256Hex(value));
      const tokens = (JSON.parse(listText) as { tokens: TokenView[] }).tokens;
      // ログインで発行したトークンも並び、発行元で見分けられる
      expect(tokens.map((token) => token.origin).sort()).toEqual(['issued', 'login']);

      const journal = JSON.stringify(await stores.journal.list());
      expect(journal).not.toContain(value);
      expect(journal).not.toContain(sha256Hex(value));
      expect(journal).toContain('アクセストークンを発行');
      expect(journal).toContain(sha256Hex(value).slice(0, 12));
      expect(journal).toContain('alice');
    });
    expect(lines.join('\n')).not.toContain(value);
    // 保存は sha256 だけ
    expect(JSON.stringify(await stores.auth.listAccessTokens('alice'))).not.toContain(value);
  });

  it('種類は read / full の2つだけ（それ以外・scopes は選べない）。full は full として保存される', async () => {
    const app = buildApp();
    const full = await issue(app, bearer(LOGIN_ALICE), { name: 'f', kind: 'full' });
    expect(full.json.token).toMatchObject({ kind: 'full', origin: 'issued' });
    for (const kind of ['admin', 'write', '', null, ['read']]) {
      expect(
        (await issue(app, bearer(LOGIN_ALICE), { name: 'x', kind })).status,
        String(kind),
      ).toBe(400);
    }
    // scopes は定義に無いので受け取っても何も変わらない（種類は read のまま）
    const withScopes = await issue(app, bearer(LOGIN_ALICE), { name: 's', scopes: ['write'] });
    expect(withScopes.json.token?.kind).toBe('read');
  });

  it('期限: 省略は 30 日後・無期限は expiresAt: null を明示したときだけ・指定はそのまま・過去は 400', async () => {
    const app = buildApp();
    const omitted = await issue(app, bearer(LOGIN_ALICE), { name: 'a' });
    expect(omitted.json.token?.expiresAt).toBe(new Date(T0 + 30 * DAY_MS).toISOString());
    const never = await issue(app, bearer(LOGIN_ALICE), { name: 'b', expiresAt: null });
    expect(never.status).toBe(200);
    expect(never.json.token?.expiresAt).toBeNull();
    const explicit = new Date(T0 + 7 * DAY_MS).toISOString();
    const given = await issue(app, bearer(LOGIN_ALICE), { name: 'c', expiresAt: explicit });
    expect(given.json.token?.expiresAt).toBe(explicit);

    const before = (await stores.auth.listAccessTokens('alice')).length;
    for (const expiresAt of [new Date(T0 - 1).toISOString(), new Date(T0).toISOString()]) {
      expect((await issue(app, bearer(LOGIN_ALICE), { name: 'd', expiresAt })).status).toBe(400);
    }
    expect((await stores.auth.listAccessTokens('alice')).length).toBe(before);

    // 期限が来たら使えない
    nowMs = T0 + 31 * DAY_MS;
    const expired = await app.request('/auth/me', {
      headers: bearer(omitted.json.value ?? ''),
    });
    expect(expired.status).toBe(401);
    const noExpiry = await app.request('/auth/me', { headers: bearer(never.json.value ?? '') });
    expect(noExpiry.status).toBe(200);
  });

  it('名前は必須で、空・長すぎる・NUL・孤立サロゲートは 400（何も作らない）', async () => {
    const app = buildApp();
    const before = (await stores.auth.listAccessTokens('alice')).length;
    for (const name of ['', '   ', 'a'.repeat(201), 'n\u0000ul', 'lone\ud800surrogate', 7, null]) {
      expect((await issue(app, bearer(LOGIN_ALICE), { name })).status, String(name)).toBe(400);
    }
    expect((await issue(app, bearer(LOGIN_ALICE), {})).status).toBe(400);
    expect((await stores.auth.listAccessTokens('alice')).length).toBe(before);
  });

  it('アカウントの資格は他のアカウントへ発行できない（403・何も作らない）。自分の id の指定は通る', async () => {
    const app = buildApp();
    const other = await issue(app, bearer(LOGIN_ALICE), { name: 'x', accountId: 'bob' });
    expect(other.status).toBe(403);
    expect(await stores.auth.listAccessTokens('bob')).toHaveLength(1);
    const self = await issue(app, bearer(LOGIN_ALICE), { name: 'x', accountId: 'alice' });
    expect(self.status).toBe(200);
  });

  it('operator は accountId が必須で、許可済みのアカウントにだけ発行できる（issuedBy は operator）', async () => {
    const app = buildApp();
    expect((await issue(app, OPERATOR, { name: 'x' })).status).toBe(400);
    expect((await issue(app, OPERATOR, { name: 'x', accountId: 'carol' })).status).toBe(400);
    expect((await issue(app, OPERATOR, { name: 'x', accountId: 'nobody' })).status).toBe(400);
    expect(await stores.auth.listAccessTokens('carol')).toEqual([]);

    const ok = await issue(app, OPERATOR, { name: '持ち主から', accountId: 'bob', kind: 'full' });
    expect(ok.status).toBe(200);
    expect(ok.json.token).toMatchObject({ accountId: 'bob', issuedBy: 'operator', kind: 'full' });
    const journal = JSON.stringify(await stores.journal.list());
    expect(journal).toContain('実行環境の持ち主による操作');
  });

  it('日誌が書けなければ 500（journal_write_failed）で、トークンは1本も増えない', async () => {
    const failing: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: () => Promise.reject(new Error('journal down (test)')),
      },
    };
    const app = buildApp(failing);
    const before = (await stores.auth.listAccessTokens('alice')).length;
    let response: Response | undefined;
    await captureStderr(async () => {
      response = await app.request('/access-tokens', {
        method: 'POST',
        headers: { ...bearer(LOGIN_ALICE), ...JSON_HEADERS },
        body: JSON.stringify({ name: 'x' }),
      });
    });
    expect(response?.status).toBe(500);
    expect(await response?.json()).toMatchObject({ code: 'journal_write_failed' });
    expect((await stores.auth.listAccessTokens('alice')).length).toBe(before);
  });

  it('保存が失敗したら打ち消しの日誌を足して例外を伝える（記録が多すぎる側に倒す）', async () => {
    const failing: Stores = {
      ...stores,
      auth: new Proxy(stores.auth, {
        get: (target, prop) => {
          if (prop === 'putAccessToken')
            return () => Promise.reject(new Error('store down (test)'));
          const member = Reflect.get(target, prop) as unknown;
          return typeof member === 'function' ? member.bind(target) : member;
        },
      }),
    };
    const app = buildApp(failing);
    let response: Response | undefined;
    await captureStderr(async () => {
      response = await app.request('/access-tokens', {
        method: 'POST',
        headers: { ...bearer(LOGIN_ALICE), ...JSON_HEADERS },
        body: JSON.stringify({ name: 'x' }),
      });
    });
    expect(response?.status).toBe(500);
    const journal = JSON.stringify(await stores.journal.list());
    expect(journal).toContain('アクセストークンを発行:');
    expect(journal).toContain('アクセストークンを発行できなかった');
  });
});

describe('一覧と失効（そのアカウントのトークンだけ・冪等）', () => {
  it('失効は冪等で、先の時刻を動かさず日誌も足さない。失効したトークンは 401', async () => {
    const app = buildApp();
    const issued = await issuedValue(app, 'read');
    expect((await app.request('/auth/me', { headers: bearer(issued.value) })).status).toBe(200);

    const first = await revoke(app, bearer(LOGIN_ALICE), issued.id);
    expect(first.status).toBe(200);
    const firstView = ((await first.json()) as { token: TokenView }).token;
    expect(firstView.revokedAt).toBe(new Date(T0).toISOString());
    nowMs += 5000;
    const second = await revoke(app, bearer(LOGIN_ALICE), issued.id);
    expect(((await second.json()) as { token: TokenView }).token.revokedAt).toBe(
      firstView.revokedAt,
    );
    const journal = await stores.journal.list();
    expect(
      journal.filter((e) => e.type === 'decision' && e.decision.includes('アクセストークンを失効')),
    ).toHaveLength(1);
    expect((await app.request('/auth/me', { headers: bearer(issued.value) })).status).toBe(401);
  });

  it('他のアカウントのトークンは一覧にも失効にも出ない（失効は 404 で状態不変）。operator は accountId で指定する', async () => {
    const app = buildApp();
    const mine = await issuedValue(app, 'read');
    const theirs = await issuedValue(app, 'read', LOGIN_BOB);

    const list = await app.request('/access-tokens', { headers: bearer(LOGIN_ALICE) });
    const ids = ((await list.json()) as { tokens: TokenView[] }).tokens.map((token) => token.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);

    expect((await revoke(app, bearer(LOGIN_ALICE), theirs.id)).status).toBe(404);
    expect((await stores.auth.listAccessTokens('bob')).every((t) => t.revokedAt === null)).toBe(
      true,
    );
    expect(
      (await app.request(`/access-tokens?accountId=bob`, { headers: bearer(LOGIN_ALICE) })).status,
    ).toBe(403);

    // operator: accountId が無ければ 400、あれば指定のアカウントだけ
    expect((await app.request('/access-tokens', { headers: OPERATOR })).status).toBe(400);
    expect((await revoke(app, OPERATOR, theirs.id)).status).toBe(400);
    expect(
      (await app.request('/access-tokens?accountId=nobody', { headers: OPERATOR })).status,
    ).toBe(404);
    const operatorList = await app.request('/access-tokens?accountId=bob', { headers: OPERATOR });
    const bobIds = ((await operatorList.json()) as { tokens: TokenView[] }).tokens.map((t) => t.id);
    expect(bobIds).toContain(theirs.id);
    expect(bobIds).not.toContain(mine.id);
    expect((await revoke(app, OPERATOR, theirs.id, '?accountId=alice')).status).toBe(404);
    expect((await revoke(app, OPERATOR, theirs.id, '?accountId=bob')).status).toBe(200);
  });

  it('失効の日誌が書けなければ 500 で、トークンは失効せず使える', async () => {
    const healthy = buildApp();
    const issued = await issuedValue(healthy, 'read');
    const failing: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: () => Promise.reject(new Error('journal down (test)')),
      },
    };
    const app = buildApp(failing);
    let response: Response | undefined;
    await captureStderr(async () => {
      response = await revoke(app, bearer(LOGIN_ALICE), issued.id);
    });
    expect(response?.status).toBe(500);
    expect((await healthy.request('/auth/me', { headers: bearer(issued.value) })).status).toBe(200);
  });
});

describe('発行したトークンは発行・一覧・失効を呼べない（read / full どちらも 403）', () => {
  it.each(['read', 'full'] as const)(
    '%s のトークンは /access-tokens の3口を 403 で断られ、状態も日誌も変わらない',
    async (kind) => {
      const app = buildApp();
      const issued = await issuedValue(app, kind);
      const other = await issuedValue(app, 'read');
      const tokensBefore = (await stores.auth.listAccessTokens('alice')).length;
      const journalBefore = (await stores.journal.list()).length;
      const headers = { ...bearer(issued.value), ...JSON_HEADERS };

      const lines = await captureStderr(async () => {
        const created = await app.request('/access-tokens', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'x' }),
        });
        expect(created.status).toBe(403);
        expect((await app.request('/access-tokens', { headers })).status).toBe(403);
        const revoked = await app.request(`/access-tokens/${other.id}/revoke`, {
          method: 'POST',
          headers,
          body: '{}',
        });
        expect(revoked.status).toBe(403);
      });
      expect((await stores.auth.listAccessTokens('alice')).length).toBe(tokensBefore);
      expect((await stores.journal.list()).length).toBe(journalBefore);
      expect((await app.request('/auth/me', { headers: bearer(other.value) })).status).toBe(200);
      // 断った試みはデーモンのログへ（値は出さない）
      expect(lines.join('\n')).toContain('アクセストークンの要求を断った');
      expect(lines.join('\n')).not.toContain(issued.value);
    },
  );

  it('自分自身の失効は POST /auth/logout でできる（同じアカウントの他のトークンは巻き込まない）', async () => {
    const app = buildApp();
    const issued = await issuedValue(app, 'read');
    const logout = await app.request('/auth/logout', {
      method: 'POST',
      headers: { ...bearer(issued.value), ...JSON_HEADERS },
      body: '{}',
    });
    expect(logout.status).toBe(200);
    expect((await app.request('/auth/me', { headers: bearer(issued.value) })).status).toBe(401);
    expect((await app.request('/auth/me', { headers: bearer(LOGIN_ALICE) })).status).toBe(200);
  });

  it('連携の鍵は3口とも 403（従来どおり）', async () => {
    const app = buildApp();
    const keyResponse = await app.request('/integration-keys', {
      method: 'POST',
      headers: { ...OPERATOR, ...JSON_HEADERS },
      body: JSON.stringify({ name: 'k', source: 'ci' }),
    });
    const key = ((await keyResponse.json()) as { value: string }).value;
    const headers = { ...bearer(key), ...JSON_HEADERS };
    await captureStderr(async () => {
      expect((await app.request('/access-tokens', { headers })).status).toBe(403);
      expect(
        (
          await app.request('/access-tokens', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: 'x' }),
          })
        ).status,
      ).toBe(403);
      expect(
        (await app.request('/access-tokens/x/revoke', { method: 'POST', headers, body: '{}' }))
          .status,
      ).toBe(403);
    });
  });
});

describe('read のトークンの許可表（既定拒否）', () => {
  it('許可表の一覧そのものを固定する（足すときはこの歯が落ちて気づく）', () => {
    expect(READ_TOKEN_ALLOWED_ROUTES.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /auth/me',
      'POST /auth/logout',
      'POST /mcp',
      'GET /memory',
      'GET /memory/:slug',
      'GET /journal',
      'GET /usage',
      'GET /self/prompt',
    ]);
  });

  it('判定は明示の一覧だけ: GET でも載っていない口・似たパス・メソッド違い・HEAD は通さない', () => {
    for (const [method, path] of [
      ['GET', '/credentials'],
      ['GET', '/mcp-servers'],
      ['GET', '/profile'],
      ['GET', '/access-tokens'],
      ['GET', '/access'],
      ['GET', '/tokens'],
      ['GET', '/integration-keys'],
      ['GET', '/journal/stream'],
      ['GET', '/journal/abc'],
      ['GET', '/memory/'],
      ['GET', '/memory/a/b'],
      ['GET', '/usage/x'],
      ['GET', '/brand-new-route'],
      ['PUT', '/memory/x'],
      ['DELETE', '/memory/x'],
      ['POST', '/memory'],
      ['POST', '/journal'],
      ['HEAD', '/journal'],
      ['OPTIONS', '/journal'],
      ['GET', '/mcp'],
      ['POST', '/auth/me'],
      ['GET', '/auth/logout'],
      ['POST', '/access-tokens'],
      ['POST', '/access-tokens/x/revoke'],
    ] as const) {
      expect(judgeReadTokenRoute(method, path).allowed, `${method} ${path}`).toBe(false);
    }
    for (const route of READ_TOKEN_ALLOWED_ROUTES) {
      const path = route.path.replace(':slug', 'daily');
      expect(judgeReadTokenRoute(route.method, path).allowed, path).toBe(true);
      expect(judgeReadTokenRoute(route.method.toLowerCase(), path).allowed, path).toBe(true);
    }
  });

  it('openapi の全ルートを回す: read で通る（403 以外）のは許可表の経路だけで、残りはすべて 403', async () => {
    const app = buildApp();
    const service = authServiceOf(stores);
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const methods = ['get', 'post', 'put', 'delete', 'patch'];
    const routes = Object.entries(spec.paths).flatMap(([path, item]) =>
      methods.filter((m) => m in item).map((method) => ({ method, path })),
    );
    expect(routes.length).toBeGreaterThan(80);
    for (const [method, path] of [
      ['post', '/access-tokens'],
      ['get', '/access-tokens'],
      ['post', '/access-tokens/{id}/revoke'],
      ['post', '/integration-keys'],
      ['get', '/credentials'],
      ['get', '/mcp-servers'],
      ['get', '/profile'],
      ['post', '/reset'],
      ['post', '/access/{accountId}/grant'],
    ] as const) {
      expect(routes).toContainEqual({ method, path });
    }

    const isPublic = (path: string) =>
      path === '/health' ||
      path === '/openapi.json' ||
      path === '/docs' ||
      (path.startsWith('/auth/') && path !== '/auth/me' && path !== '/auth/logout');
    const normalize = (path: string) => path.replace(/\{[^}]+\}|:[^/]+/g, ':p');

    const passed: string[] = [];
    const denied: string[] = [];
    const wrongBody: string[] = [];
    await captureStderr(async () => {
      for (const { method, path } of routes) {
        if (isPublic(path)) continue;
        // 1本ごとに新しい read のトークンを使う（`POST /auth/logout` が自分を失効させるため）
        const { value } = await service.issueAccessToken({
          accountId: 'alice',
          name: `probe ${method} ${path}`,
          kind: 'read',
          expiresAt: null,
          issuedBy: 'alice',
        });
        const hasBody = method !== 'get' && method !== 'delete';
        const response = await app.request(path.replace(/\{[^}]+\}/g, 'x'), {
          method: method.toUpperCase(),
          headers: { ...bearer(value), ...JSON_HEADERS },
          ...(hasBody ? { body: '{}' } : {}),
        });
        const key = `${method.toUpperCase()} ${normalize(path)}`;
        if (response.status === 403) {
          denied.push(key);
          if (!(await response.text()).includes('読み取り用のアクセストークン（read）')) {
            wrongBody.push(key);
          }
        } else {
          passed.push(key);
        }
      }
    });
    expect(wrongBody).toEqual([]);
    expect(passed.sort()).toEqual(
      READ_TOKEN_ALLOWED_ROUTES.map((route) => `${route.method} ${normalize(route.path)}`).sort(),
    );
    expect(denied).toContain('POST /access-tokens');
    expect(denied).toContain('GET /credentials');
    expect(denied).toContain('GET /mcp-servers');
    expect(denied).toContain('GET /profile');
    expect(denied).toContain('POST /reset');
    expect(denied).toContain('GET /access-tokens');
    expect(denied.length + passed.length).toBe(routes.filter(({ path }) => !isPublic(path)).length);
  });

  it('openapi に新しい経路が増えても、許可表に入れない限り read では自動で通らない（陰性対照つき）', async () => {
    const app = buildApp();
    // 門より後ろに足した新しい口（書き込みでも GET でも）
    app.get('/zz-brand-new-read', (c) => c.json({ ok: true }));
    app.post('/zz-brand-new-write', (c) => c.json({ ok: true }));
    const read = await issuedValue(app, 'read');
    const full = await issuedValue(app, 'full');
    for (const [method, path] of [
      ['GET', '/zz-brand-new-read'],
      ['POST', '/zz-brand-new-write'],
    ] as const) {
      const attempt = (value: string) =>
        app.request(path, { method, headers: { ...bearer(value), ...JSON_HEADERS } });
      await captureStderr(async () => {
        expect((await attempt(read.value)).status, `read ${path}`).toBe(403);
      });
      expect((await attempt(full.value)).status, `full ${path}`).toBe(200);
      expect((await attempt('alt_alice-login-token')).status, `login ${path}`).toBe(200);
    }
  });

  it('read で記憶・日誌・利用・プロンプトの読み取りと本人確認は通る。値を返す口と書き込みは 403', async () => {
    const app = buildApp();
    const { value } = await issuedValue(app, 'read');
    const headers = bearer(value);
    for (const path of ['/memory', '/journal', '/usage', '/self/prompt', '/auth/me']) {
      expect((await app.request(path, { headers })).status, path).toBe(200);
    }
    await captureStderr(async () => {
      for (const path of ['/credentials', '/mcp-servers', '/profile', '/access', '/status']) {
        expect((await app.request(path, { headers })).status, path).toBe(403);
      }
      const write = await app.request('/memory/x', {
        method: 'PUT',
        headers: { ...headers, ...JSON_HEADERS },
        body: JSON.stringify({ content: 'x' }),
      });
      expect(write.status).toBe(403);
    });
    expect(await stores.persona.list()).toEqual([]);
  });

  it('read で POST /mcp の tools/list が読み取りの道具と report_problem を出す', async () => {
    const app = buildApp();
    const { value } = await issuedValue(app, 'read');
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...bearer(value) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(200);
    const json = JSON.parse(await response.text()) as { result?: { tools?: { name: string }[] } };
    expect(json.result?.tools?.map((tool) => tool.name)).toEqual([
      'report_problem',
      'memory_list',
      'memory_read',
      'journal_read',
      'usage_read',
      'self_prompt',
      'exchanges',
    ]);
  });
});

describe('full はログインのトークンと同じ強さ（発行の3口を除く）', () => {
  const probes: { method: string; path: string; body?: unknown }[] = [
    { method: 'GET', path: '/status' },
    { method: 'GET', path: '/access' },
    { method: 'GET', path: '/credentials' },
    { method: 'GET', path: '/mcp-servers' },
    { method: 'GET', path: '/profile' },
    { method: 'GET', path: '/integration-keys' },
    { method: 'GET', path: '/tokens' },
    { method: 'GET', path: '/schedule' },
    { method: 'GET', path: '/memory' },
    { method: 'PUT', path: '/memory/probe', body: { content: 'x' } },
    { method: 'POST', path: '/integration-keys', body: { name: 'k', source: 'ci' } },
    { method: 'POST', path: '/access/bob/revoke', body: {} },
  ];

  it('ログインのトークンと同じ状態コードを返し、403 にならない（read は同じ口が 403）', async () => {
    const app = buildApp();
    const full = await issuedValue(app, 'full');
    const read = await issuedValue(app, 'read');
    const run = (value: string, probe: (typeof probes)[number]) =>
      app.request(probe.path, {
        method: probe.method,
        headers: { ...bearer(value), ...JSON_HEADERS },
        ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
      });
    for (const probe of probes) {
      // 同じ状態から比べる: 書き込みの副作用が次の比較に残らないよう、ログインのトークンを先に試す
      const login = await run(LOGIN_ALICE, probe);
      const viaFull = await run(full.value, probe);
      expect(viaFull.status, `${probe.method} ${probe.path}`).toBe(login.status);
      expect(viaFull.status, `${probe.method} ${probe.path}`).not.toBe(403);
      await captureStderr(async () => {
        expect((await run(read.value, probe)).status, `read ${probe.method} ${probe.path}`).toBe(
          probe.method === 'GET' && ['/memory'].includes(probe.path) ? 200 : 403,
        );
      });
    }
  });

  it('ログインで発行済みの既存トークンは full として動き続ける（一覧では origin: login）', async () => {
    const app = buildApp();
    expect((await app.request('/auth/me', { headers: bearer(LOGIN_ALICE) })).status).toBe(200);
    // read では 403 になる口（`/status`）が、ログインで発行済みのトークンでは通る
    expect((await app.request('/status', { headers: bearer(LOGIN_ALICE) })).status).toBe(200);
    const list = await app.request('/access-tokens', { headers: bearer(LOGIN_ALICE) });
    const tokens = ((await list.json()) as { tokens: TokenView[] }).tokens;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ kind: 'full', origin: 'login', issuedBy: null });
  });

  it('この欄が無かった頃の行（kind / origin / issuedBy が無い）も、同じく full・login として通る', async () => {
    const legacy = 'alt_legacy-row-token';
    const row = {
      id: 'tok-legacy',
      accountId: 'alice',
      sha256: sha256Hex(legacy),
      label: 'old',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    // ストアは書き込みでスキーマの既定を当てる（fs は読み込みでも当てる）
    await stores.auth.putAccessToken(row as never);
    const app = buildApp();
    expect((await app.request('/status', { headers: bearer(legacy) })).status).toBe(200);
  });
});

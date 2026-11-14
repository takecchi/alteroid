import type { OAuthProvider, Stores } from '@alteroid/core';
import {
  createAuthProviderRegistry,
  createAuthService,
  createMemoryStores,
  fakeCloneHost,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { AuthPlan } from './auth.js';

// `GET /self/prompt` は既存の `authenticate` だけで通る（アクセストークンも実行環境の持ち主も）。新しい資格・スコープは無く、連携の鍵（`altk_`）は既定で拒否される。

const FAKE_PROVIDER: OAuthProvider = {
  kind: 'oauth2',
  id: 'fake',
  label: 'Fake',
  authorizationUrl: (request) => `https://example.test/authorize?state=${request.state}`,
  exchange: async () => ({
    subject: 'sub-1',
    email: 'sub-1@example.test',
    emailVerified: true,
    displayName: 'sub-1',
  }),
};

const OPERATOR = { authorization: 'Bearer test-token' };
const post = { method: 'POST', headers: { 'content-type': 'application/json' } };

let stores: Stores;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  stores = createMemoryStores();
  const plan: AuthPlan = {
    enabled: true,
    providers: [FAKE_PROVIDER],
    publicBaseUrl: 'http://127.0.0.1:4517',
    tokenTtlDays: 30,
    description: 'テスト',
  };
  app = createApp({
    clone: fakeCloneHost(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    journalEvents: { subscribe: () => () => undefined },
    auth: {
      plan,
      service: createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry([FAKE_PROVIDER]),
      }),
    },
  });
});

async function loginThrough() {
  const started = (await (
    await app.request('/auth/login', { ...post, body: JSON.stringify({ provider: 'fake' }) })
  ).json()) as { requestId: string; authorizationUrl: string; claimSecret: string };
  const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
  expect(
    (await app.request(`/auth/fake/callback?code=any&state=${encodeURIComponent(state)}`)).status,
  ).toBe(200);
  return (await (
    await app.request(`/auth/login/${started.requestId}/claim`, {
      ...post,
      body: JSON.stringify({ claimSecret: started.claimSecret }),
    })
  ).json()) as { token: string; account: { id: string } };
}

describe('GET /self/prompt — 資格（既存の authenticate だけ）', () => {
  it('資格が無ければ 401、間違ったトークンも 401', async () => {
    expect((await app.request('/self/prompt')).status).toBe(401);
    expect(
      (await app.request('/self/prompt', { headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
  });

  it('実行環境の持ち主の token で通る', async () => {
    expect((await app.request('/self/prompt', { headers: OPERATOR })).status).toBe(200);
  });

  it('許可されたアカウントのアクセストークンで通り、許可の無いアカウントは 403', async () => {
    const claimed = await loginThrough();
    const headers = { authorization: `Bearer ${claimed.token}` };
    expect((await app.request('/self/prompt', { headers })).status).toBe(403);
    await stores.auth.grantAccess(claimed.account.id, '2026-01-01T00:00:00.000Z', 'test');
    expect((await app.request('/self/prompt', { headers })).status).toBe(200);
  });

  it('連携の鍵（altk_）は通らない（403。既定で拒否する既存の仕組みのまま）', async () => {
    const issued = await app.request('/integration-keys', {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
      body: JSON.stringify({ name: 'ci の鍵', source: 'ci.main' }),
    });
    expect(issued.status).toBe(200);
    const { value } = (await issued.json()) as { value: string };
    const response = await app.request('/self/prompt', {
      headers: { authorization: `Bearer ${value}` },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('promptSnapshot');
  });
});

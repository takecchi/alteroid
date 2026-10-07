import type { AuthAccount, CloneHost, ManagerPool, OAuthProvider, Stores } from '@alteroid/core';
import {
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  createCredentialService,
  createMemoryStores,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import {
  AUTH_ENV,
  GOOGLE_CLIENT_ID_ENV,
  GOOGLE_CLIENT_SECRET_ENV,
  PUBLIC_URL_ENV,
  planAuth,
  type AuthPlan,
} from './auth.js';
import { accountWithIdentitiesSchema } from './openapi.js';

function stubClone(): CloneHost {
  const managers: ManagerPool = {
    start: () => Promise.reject(new Error('起こさない')),
    send: () => Promise.reject(new Error('送らない')),
    abort: () => Promise.reject(new Error('止めない')),
    list: () => Promise.resolve([]),
    denials: () => [],
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    runners: () =>
      Promise.resolve({ runners: [], unassigned: [], daemonRevision: { status: 'unknown' } }),
    pushHealthOf: () => undefined,
    transcript: () => Promise.resolve({ kind: 'missing' as const }),
    unpushedWork: () =>
      Promise.resolve({ kind: 'unavailable' as const, reason: '(この検証では未使用)' }),
    runningManagerOwning: () => undefined,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: () => undefined,
    vacate: () => Promise.resolve({}),
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    settleStalledUsageWakes: () => Promise.resolve([]),
    renotifyStalledDenials: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  return {
    managers,
    post: () => 'conversation-1',
    subscribe: () => () => undefined,
    attach: () => ({ inProgress: [{ type: 'thinking' }], unsubscribe: () => undefined }),
    endConversation: () => Promise.resolve(),
    answerApproval: () => Promise.resolve(true),
    stop: () => Promise.resolve(),
  } as unknown as CloneHost;
}

let nextSubject = 'sub-1';

const FAKE_PROVIDER: OAuthProvider = {
  kind: 'oauth2',
  id: 'fake',
  label: 'Fake',
  authorizationUrl: (request) => `https://example.test/authorize?state=${request.state}`,
  exchange: async () => ({
    subject: nextSubject,
    email: `${nextSubject}@example.test`,
    emailVerified: true,
    displayName: nextSubject,
  }),
};

const OPERATOR = { authorization: 'Bearer test-token' };
const post = { method: 'POST', headers: { 'content-type': 'application/json' } };

let stores: Stores;

function withLeakedAccountField(auth: Stores['auth']): Stores['auth'] {
  const leak = (account: AuthAccount): AuthAccount =>
    ({ ...account, leakedField: 'should-not-escape' }) as AuthAccount;
  return {
    ...auth,
    async listAccounts() {
      return (await auth.listAccounts()).map(leak);
    },
    async getAccount(id) {
      const account = await auth.getAccount(id);
      return account === null ? null : leak(account);
    },
  };
}

function buildApp(
  plan: Partial<AuthPlan> = {},
  options: { leakAccountField?: boolean; sseHeartbeatMs?: number } = {},
) {
  stores = createMemoryStores();
  nextSubject = 'sub-1';
  if (options.leakAccountField === true) {
    // `authService` は包んだ後の `stores.auth` から作る: そうしないと `/auth/me` と claim には効かないため。
    stores = { ...stores, auth: withLeakedAccountField(stores.auth) };
  }
  const resolved: AuthPlan = {
    enabled: true,
    providers: [FAKE_PROVIDER],
    publicBaseUrl: 'http://127.0.0.1:4517',
    tokenTtlDays: 30,
    description: 'テスト',
    ...plan,
  };
  return createApp({
    clone: stubClone(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    journalEvents: { subscribe: () => () => undefined },
    ...(options.sseHeartbeatMs === undefined ? {} : { sseHeartbeatMs: options.sseHeartbeatMs }),
    auth: {
      plan: resolved,
      service: createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry(resolved.providers),
      }),
    },
  });
}

function buildAppOverridingStores(override: Partial<Stores>) {
  const overridden: Stores = { ...stores, ...override };
  return createApp({
    clone: stubClone(),
    stores: overridden,
    token: 'test-token',
    shutdown: () => undefined,
    journalEvents: { subscribe: () => () => undefined },
    auth: {
      plan: {
        enabled: true,
        providers: [FAKE_PROVIDER],
        publicBaseUrl: 'http://127.0.0.1:4517',
        tokenTtlDays: 30,
        description: 'テスト',
      },
      service: createAuthService({
        store: overridden.auth,
        providers: createAuthProviderRegistry([FAKE_PROVIDER]),
      }),
    },
  });
}

async function loginThrough(app: ReturnType<typeof createApp>) {
  const started = (await (
    await app.request('/auth/login', { ...post, body: JSON.stringify({ provider: 'fake' }) })
  ).json()) as { requestId: string; authorizationUrl: string; claimSecret: string };

  const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
  const callback = await app.request(
    `/auth/fake/callback?code=any&state=${encodeURIComponent(state)}`,
  );
  expect(callback.status).toBe(200);

  const claimed = (await (
    await app.request(`/auth/login/${started.requestId}/claim`, {
      ...post,
      body: JSON.stringify({ claimSecret: started.claimSecret }),
    })
  ).json()) as {
    status: string;
    token: string;
    granted: boolean;
    account: { id: string };
  };
  return claimed;
}

describe('planAuth', () => {
  it('ログイン手段が未設定なら認証を要求しない（境界の導入をデグレードにしない）', () => {
    const plan = planAuth({}, { port: 4517 });
    expect(plan.enabled).toBe(false);
    expect(plan.providers).toEqual([]);
  });

  it('Google の鍵が揃えば自動で有効になる（設定したのに効かない方が事故）', () => {
    const plan = planAuth(
      { [GOOGLE_CLIENT_ID_ENV]: 'id', [GOOGLE_CLIENT_SECRET_ENV]: 'secret' },
      { port: 4517 },
    );
    expect(plan.enabled).toBe(true);
    expect(plan.providers.map((provider) => provider.id)).toEqual(['google']);
  });

  it('ALTEROID_AUTH=off なら鍵が揃っていても要求しない（方針は設定で開けられる）', () => {
    const plan = planAuth(
      {
        [AUTH_ENV]: 'off',
        [GOOGLE_CLIENT_ID_ENV]: 'id',
        [GOOGLE_CLIENT_SECRET_ENV]: 'secret',
      },
      { port: 4517 },
    );
    expect(plan.enabled).toBe(false);
  });

  it('戻り先の起点は ALTEROID_PUBLIC_URL で差し替えられる（クラウド常駐のため）', () => {
    const plan = planAuth({ [PUBLIC_URL_ENV]: 'https://alteroid.example/' }, { port: 4517 });
    expect(plan.publicBaseUrl).toBe('https://alteroid.example');
  });
});

describe('認証が無効なとき', () => {
  it('この機能が入る前とまったく同じに通る（能力を削らない）', async () => {
    const app = buildApp({ enabled: false, providers: [] });
    expect((await app.request('/memory')).status).toBe(200);
    expect((await app.request('/journal')).status).toBe(200);
  });
});

describe('認証が有効なとき', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = buildApp();
  });

  it('資格が無ければ 401（記憶にも日誌にも触れない）', async () => {
    expect((await app.request('/memory')).status).toBe(401);
    expect((await app.request('/journal')).status).toBe(401);
    expect((await app.request('/chat/conv-a/stream')).status).toBe(401);
  });

  it('/health と /auth/* は資格が無くても読める（ログインの前に通る必要がある）', async () => {
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/auth/providers')).status).toBe(200);
  });

  it('GET /status（記憶の置き場）は資格が無ければ 401、持ち主のトークンなら通る（#2869）', async () => {
    expect((await app.request('/status')).status).toBe(401);
    const response = await app.request('/status', { headers: OPERATOR });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('storage');
  });

  it('実行環境の持ち主のトークンで通る（ログインせずに手元から使える）', async () => {
    const response = await app.request('/memory', { headers: OPERATOR });
    expect(response.status).toBe(200);
  });

  it('ログインしただけでは 403（許可は人間が別に与える）', async () => {
    const claimed = await loginThrough(app);
    expect(claimed.status).toBe('ready');
    expect(claimed.granted).toBe(false);

    const response = await app.request('/memory', {
      headers: { authorization: `Bearer ${claimed.token}` },
    });
    expect(response.status).toBe(403);
  });

  it('許可を与えると同じトークンで通り、取り消すとまた通らなくなる', async () => {
    const claimed = await loginThrough(app);
    const auth = { authorization: `Bearer ${claimed.token}` };

    const granted = await app.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    expect(granted.status).toBe(200);
    expect((await app.request('/memory', { headers: auth })).status).toBe(200);

    const revoked = await app.request(`/access/${claimed.account.id}/revoke`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    expect(revoked.status).toBe(200);
    expect((await app.request('/memory', { headers: auth })).status).toBe(403);
  });

  describe('POST /auth/logout', () => {
    it('提示したトークンだけを失効させ、以後は同じトークンで401（応答に鍵は載せない）', async () => {
      const claimed = await loginThrough(app);
      const auth = { authorization: `Bearer ${claimed.token}` };
      await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      expect((await app.request('/memory', { headers: auth })).status).toBe(200);

      const logout = await app.request('/auth/logout', {
        ...post,
        headers: { ...post.headers, ...auth },
      });
      expect(logout.status).toBe(200);
      const body: unknown = await logout.json();
      expect(body).toEqual({ ok: true });
      expect(JSON.stringify(body)).not.toContain(claimed.token);

      expect((await app.request('/memory', { headers: auth })).status).toBe(401);
      const again = await app.request('/auth/logout', {
        ...post,
        headers: { ...post.headers, ...auth },
      });
      expect(again.status).toBe(401);
    });

    it('同じアカウントの別のトークン（別端末からの2本目のログイン）は巻き込まない', async () => {
      const first = await loginThrough(app);
      await app.request(`/access/${first.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      const second = await loginThrough(app);
      expect(second.account.id).toBe(first.account.id);

      const logout = await app.request('/auth/logout', {
        ...post,
        headers: { ...post.headers, authorization: `Bearer ${first.token}` },
      });
      expect(logout.status).toBe(200);

      const firstAuth = { authorization: `Bearer ${first.token}` };
      const secondAuth = { authorization: `Bearer ${second.token}` };
      expect((await app.request('/memory', { headers: firstAuth })).status).toBe(401);
      expect((await app.request('/memory', { headers: secondAuth })).status).toBe(200);
    });

    it('operator の資格（状態ファイルの token）では断られる（4xx。失効させる対象を持たない）', async () => {
      const response = await app.request('/auth/logout', {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      expect(response.status).toBe(400);
      expect((await app.request('/memory', { headers: OPERATOR })).status).toBe(200);
    });

    it('許可待ちのトークンも失効させられ、後から許可を与えても生き返らない', async () => {
      const claimed = await loginThrough(app);
      expect(claimed.granted).toBe(false);
      const auth = { authorization: `Bearer ${claimed.token}` };
      expect((await app.request('/memory', { headers: auth })).status).toBe(403);

      const logout = await app.request('/auth/logout', {
        ...post,
        headers: { ...post.headers, ...auth },
      });
      expect(logout.status).toBe(200);

      const granted = await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      expect(granted.status).toBe(200);
      expect((await app.request('/memory', { headers: auth })).status).toBe(401);
    });

    it('認証なしでは401（公開の口になっていない——/auth/me と同じ例外）', async () => {
      const response = await app.request('/auth/logout', post);
      expect(response.status).toBe(401);
    });

    it('ブラウザの単純リクエストでは通らない（content-type の門番）', async () => {
      const claimed = await loginThrough(app);
      await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      const response = await app.request('/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${claimed.token}` },
      });
      expect(response.status).toBe(415);
    });
  });

  it('許可されたアカウントも実行環境の持ち主と同格——自分自身への再 grant も GET /access も通る', async () => {
    const claimed = await loginThrough(app);
    await app.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });

    const response = await app.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, authorization: `Bearer ${claimed.token}` },
    });
    expect(response.status).toBe(200);
    expect(
      (await app.request('/access', { headers: { authorization: `Bearer ${claimed.token}` } }))
        .status,
    ).toBe(200);
  });

  it('実行環境プロファイルは許可済みなら宣言の有無にかかわらず通る（2026-10-05、#2862。許可の無い利用者は 403 のまま）', async () => {
    const claimed = await loginThrough(app);
    const auth = { authorization: `Bearer ${claimed.token}` };

    expect((await app.request('/profile', { headers: auth })).status).toBe(403);
    expect((await app.request('/profile')).status).toBe(401);

    await app.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });

    expect((await app.request('/profile', { headers: auth })).status).toBe(200);
    expect(
      (
        await app.request('/profile', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ script: 'env' }),
        })
      ).status,
    ).not.toBe(403);

    expect((await app.request('/profile', { headers: OPERATOR })).status).toBe(200);
  });

  it('許可できるアカウントの数に上限は無い（2人目の grant も 200）', async () => {
    const first = await loginThrough(app);
    nextSubject = 'sub-2';
    const second = await loginThrough(app);
    expect(second.account.id).not.toBe(first.account.id);

    for (const account of [first.account, second.account]) {
      expect(
        (
          await app.request(`/access/${account.id}/grant`, {
            ...post,
            headers: { ...post.headers, ...OPERATOR },
          })
        ).status,
      ).toBe(200);
    }

    for (const token of [first.token, second.token]) {
      expect(
        (await app.request('/memory', { headers: { authorization: `Bearer ${token}` } })).status,
      ).toBe(200);
    }

    await app.request(`/access/${first.account.id}/revoke`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    expect(
      (await app.request('/memory', { headers: { authorization: `Bearer ${first.token}` } }))
        .status,
    ).toBe(403);
    expect(
      (await app.request('/memory', { headers: { authorization: `Bearer ${second.token}` } }))
        .status,
    ).toBe(200);
  });

  it('許可の付与と取り消しは日誌に残る（事後に追えることが最終承認の実体）', async () => {
    const claimed = await loginThrough(app);
    await app.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });

    const entries = await stores.journal.list({ types: ['decision'] });
    expect(entries.some((entry) => 'decision' in entry && entry.decision.includes('付与'))).toBe(
      true,
    );
  });

  // 文言は `app.ts` から import せずここへ複製する: import すると自己整合して、ずれてもこの歯が落ちなくなるため。
  describe('日誌の「誰が」', () => {
    async function lastGrounds(): Promise<string> {
      const entries = await stores.journal.list({ types: ['decision'] });
      const newest = entries[0];
      if (newest === undefined || !('grounds' in newest)) throw new Error('decision の記録が無い');
      return newest.grounds;
    }

    it('② 実行環境の持ち主が付与したら、そう記録される（今日の挙動は変わらない）', async () => {
      const claimed = await loginThrough(app);
      await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });

      expect(await lastGrounds()).toBe('実行環境の持ち主による操作（alteroid access grant）');
    });

    it('① 許可されたアカウントが付与したら、そのアカウントが記録される', async () => {
      const claimed = await loginThrough(app);
      await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      const self = { authorization: `Bearer ${claimed.token}` };

      const response = await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...self },
      });
      expect(response.status).toBe(200);

      const grounds = await lastGrounds();
      expect(grounds).toContain(claimed.account.id);
      expect(grounds).toContain('許可されたアカウント');
      expect(grounds).not.toContain('実行環境の持ち主');
    });

    it('① 許可されたアカウントが取り消したら、そのアカウントが記録される（revoke 側）', async () => {
      const claimed = await loginThrough(app);
      await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      const self = { authorization: `Bearer ${claimed.token}` };

      const response = await app.request(`/access/${claimed.account.id}/revoke`, {
        ...post,
        headers: { ...post.headers, ...self },
      });
      expect(response.status).toBe(200);

      const grounds = await lastGrounds();
      expect(grounds).toContain(claimed.account.id);
      expect(grounds).toContain('（alteroid access revoke）');
      expect(grounds).not.toContain('実行環境の持ち主');
    });

    it('①の再 grant では grantedBy が書き換わらない（前提の固定）', async () => {
      const claimed = await loginThrough(app);
      await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });

      const response = await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, authorization: `Bearer ${claimed.token}` },
      });
      const body = (await response.json()) as { account: { grantedBy: string | null } };
      expect(body.account.grantedBy).toBe('operator');
    });

    it('①が別のアカウントを通したら、grantedBy にそのアカウントの id が残る', async () => {
      const first = await loginThrough(app);
      await app.request(`/access/${first.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });

      nextSubject = 'sub-2';
      const second = await loginThrough(app);
      const response = await app.request(`/access/${second.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, authorization: `Bearer ${first.token}` },
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as { account: { grantedBy: string | null } };
      expect(body.account.grantedBy).toBe(first.account.id);

      const grounds = await lastGrounds();
      expect(grounds).toContain(first.account.id);
      expect(grounds).not.toContain('実行環境の持ち主');
    });
  });

  describe('日誌への追記が落ちたとき（issue #2043）', () => {
    async function decisions() {
      const entries = await stores.journal.list({ types: ['decision'] });
      return entries
        .flatMap((entry) => (entry.type === 'decision' ? [entry.decision] : []))
        .reverse();
    }

    it('grant: 日誌への先書きが落ちると 500 で、許可は付与されない（grantedAt が null のまま）', async () => {
      const claimed = await loginThrough(app);
      const withFailingJournal = buildAppOverridingStores({
        journal: {
          ...stores.journal,
          append: () => {
            throw new Error('journal store unavailable (test)');
          },
        },
      });

      const response = await withFailingJournal.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      expect(response.status).toBe(500);

      const after = await stores.auth.getAccount(claimed.account.id);
      expect(after?.grantedAt).toBeNull();
      expect(after?.grantedBy).toBeNull();
      expect(await decisions()).toHaveLength(0);
    });

    it('owner: 日誌への先書きが落ちると 500 で、宣言はされない（ownerDeclaredAt が null のまま）', async () => {
      const claimed = await loginThrough(app);
      await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });

      const withFailingJournal = buildAppOverridingStores({
        journal: {
          ...stores.journal,
          append: () => {
            throw new Error('journal store unavailable (test)');
          },
        },
      });

      const response = await withFailingJournal.request(`/access/${claimed.account.id}/owner`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      expect(response.status).toBe(500);

      const after = await stores.auth.getAccount(claimed.account.id);
      expect(after?.ownerDeclaredAt).toBeNull();
      expect(await decisions()).toHaveLength(1);
    });

    it('revoke: 日誌への追記が落ちても取り消しは効いていて 200、stderr に跡が出る', async () => {
      const claimed = await loginThrough(app);
      await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });

      const withFailingJournal = buildAppOverridingStores({
        journal: {
          ...stores.journal,
          append: () => {
            throw new Error('journal store unavailable (test)');
          },
        },
      });

      let response: Response | undefined;
      const lines = await captureStderr(async () => {
        response = await withFailingJournal.request(`/access/${claimed.account.id}/revoke`, {
          ...post,
          headers: { ...post.headers, ...OPERATOR },
        });
      });

      expect(response?.status).toBe(200);
      const after = await stores.auth.getAccount(claimed.account.id);
      expect(after?.grantedAt).toBeNull();
      expect(lines.some((line) => line.includes('を記録できませんでした'))).toBe(true);
    });

    it('owner/revoke: 日誌への追記が落ちても取り消しは効いていて 200、stderr に跡が出る', async () => {
      const claimed = await loginThrough(app);
      await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      await app.request(`/access/${claimed.account.id}/owner`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });

      const withFailingJournal = buildAppOverridingStores({
        journal: {
          ...stores.journal,
          append: () => {
            throw new Error('journal store unavailable (test)');
          },
        },
      });

      let response: Response | undefined;
      const lines = await captureStderr(async () => {
        response = await withFailingJournal.request(`/access/${claimed.account.id}/owner/revoke`, {
          ...post,
          headers: { ...post.headers, ...OPERATOR },
        });
      });

      expect(response?.status).toBe(200);
      const after = await stores.auth.getAccount(claimed.account.id);
      expect(after?.ownerDeclaredAt).toBeNull();
      expect(lines.some((line) => line.includes('を記録できませんでした'))).toBe(true);
    });

    it(
      'grant: 状態変更（grantAccess）が投げたときは、付与の行と打ち消しの行の両方が' +
        '日誌に残り、500 になる',
      async () => {
        const claimed = await loginThrough(app);
        const withThrowingGrant = buildAppOverridingStores({
          auth: {
            ...stores.auth,
            grantAccess: () => {
              throw new Error('grantAccess unavailable (test)');
            },
          },
        });

        const response = await withThrowingGrant.request(`/access/${claimed.account.id}/grant`, {
          ...post,
          headers: { ...post.headers, ...OPERATOR },
        });
        expect(response.status).toBe(500);

        const after = await stores.auth.getAccount(claimed.account.id);
        expect(after?.grantedAt).toBeNull();

        const lines = await decisions();
        expect(lines.some((line) => line.startsWith('アクセス許可を付与:'))).toBe(true);
        expect(lines.some((line) => line.startsWith('アクセス許可を付与できなかった:'))).toBe(true);
      },
    );

    it(
      'owner: 状態変更（setAccountOwner）が投げたときは、宣言の行と打ち消しの行の両方が' +
        '日誌に残り、500 になる',
      async () => {
        const claimed = await loginThrough(app);
        await app.request(`/access/${claimed.account.id}/grant`, {
          ...post,
          headers: { ...post.headers, ...OPERATOR },
        });

        const withThrowingOwner = buildAppOverridingStores({
          auth: {
            ...stores.auth,
            setAccountOwner: () => {
              throw new Error('setAccountOwner unavailable (test)');
            },
          },
        });

        const response = await withThrowingOwner.request(`/access/${claimed.account.id}/owner`, {
          ...post,
          headers: { ...post.headers, ...OPERATOR },
        });
        expect(response.status).toBe(500);

        const after = await stores.auth.getAccount(claimed.account.id);
        expect(after?.ownerDeclaredAt).toBeNull();

        const lines = await decisions();
        expect(lines.some((line) => line.startsWith('実行環境の持ち主として宣言:'))).toBe(true);
        expect(
          lines.some((line) => line.startsWith('実行環境の持ち主として宣言できなかった:')),
        ).toBe(true);
      },
    );

    it('正常系はどの4口も日誌に1行だけ増え、文言はいまと変わらない', async () => {
      const claimed = await loginThrough(app);

      await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      expect(await decisions()).toEqual([expect.stringContaining('アクセス許可を付与:')]);

      await app.request(`/access/${claimed.account.id}/owner`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      expect(await decisions()).toEqual([
        expect.stringContaining('アクセス許可を付与:'),
        expect.stringContaining('実行環境の持ち主として宣言:'),
      ]);

      await app.request(`/access/${claimed.account.id}/owner/revoke`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      expect(await decisions()).toEqual([
        expect.stringContaining('アクセス許可を付与:'),
        expect.stringContaining('実行環境の持ち主として宣言:'),
        expect.stringContaining('実行環境の持ち主としての宣言を取り消し:'),
      ]);

      await app.request(`/access/${claimed.account.id}/revoke`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      expect(await decisions()).toEqual([
        expect.stringContaining('アクセス許可を付与:'),
        expect.stringContaining('実行環境の持ち主として宣言:'),
        expect.stringContaining('実行環境の持ち主としての宣言を取り消し:'),
        expect.stringContaining('アクセス許可を取り消し:'),
      ]);
    });

    it(
      'describeAccount の出力は grant の前後で変わらない' +
        '（日誌の文言を前状態から書いても、後状態と食い違わない。#2043）',
      async () => {
        const claimed = await loginThrough(app);
        const before = await stores.auth.getAccount(claimed.account.id);
        if (before === null) throw new Error('unreachable: ログイン直後のアカウント');

        await app.request(`/access/${claimed.account.id}/grant`, {
          ...post,
          headers: { ...post.headers, ...OPERATOR },
        });
        const after = await stores.auth.getAccount(claimed.account.id);
        if (after === null) throw new Error('unreachable: grant 直後のアカウント');

        expect(before.email).toBe(after.email);
        expect(before.displayName).toBe(after.displayName);
        expect(before.id).toBe(after.id);
        expect(before.grantedAt).toBeNull();
        expect(after.grantedAt).not.toBeNull();
      },
    );
  });

  it('許可の付与はブラウザの単純リクエストでは通らない（content-type の門番）', async () => {
    const claimed = await loginThrough(app);
    const response = await app.request(`/access/${claimed.account.id}/grant`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8', ...OPERATOR },
      body: 'x',
    });
    expect(response.status).toBe(415);
  });

  it('/health はトークンを返さない（提示して operator が返るだけ）', async () => {
    const anonymous = (await (await app.request('/health')).json()) as Record<string, unknown>;
    expect(anonymous.operator).toBe(false);
    expect(JSON.stringify(anonymous)).not.toContain('test-token');

    const owner = (await (await app.request('/health', { headers: OPERATOR })).json()) as Record<
      string,
      unknown
    >;
    expect(owner.operator).toBe(true);
  });

  it('claimSecret を知らない相手はトークンを引き取れない', async () => {
    const started = (await (
      await app.request('/auth/login', { ...post, body: JSON.stringify({ provider: 'fake' }) })
    ).json()) as { requestId: string; authorizationUrl: string };
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
    await app.request(`/auth/fake/callback?code=any&state=${encodeURIComponent(state)}`);

    const response = await app.request(`/auth/login/${started.requestId}/claim`, {
      ...post,
      body: JSON.stringify({ claimSecret: 'でたらめ' }),
    });
    expect(response.status).toBe(400);
  });

  it('未設定のログイン手段は始められない', async () => {
    const response = await app.request('/auth/login', {
      ...post,
      body: JSON.stringify({ provider: 'discord' }),
    });
    expect(response.status).toBe(400);
  });

  it('コールバックはトークンを URL に載せない（履歴と Referer に鍵を残さない）', async () => {
    const started = (await (
      await app.request('/auth/login', { ...post, body: JSON.stringify({ provider: 'fake' }) })
    ).json()) as { authorizationUrl: string };
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';

    const callback = await app.request(
      `/auth/fake/callback?code=any&state=${encodeURIComponent(state)}`,
    );
    const html = await callback.text();
    expect(callback.headers.get('content-type')).toContain('text/html');
    expect(html).not.toContain('alt_');
    expect(callback.headers.get('location')).toBeNull();
  });

  it('ログイン成功のコールバックは window.close() を仕込む（ポップアップを自動で閉じる）', async () => {
    const started = (await (
      await app.request('/auth/login', { ...post, body: JSON.stringify({ provider: 'fake' }) })
    ).json()) as { authorizationUrl: string };
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';

    const callback = await app.request(
      `/auth/fake/callback?code=any&state=${encodeURIComponent(state)}`,
    );
    const html = await callback.text();
    expect(html).toContain('<script>window.close()</script>');
  });

  it('code / state が無い失敗コールバックは window.close() を仕込まない（人間にエラーを読ませる）', async () => {
    const response = await app.request('/auth/fake/callback');
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).not.toContain('window.close()');
  });
});

describe('宣言と実物の一致（/auth・/access）', () => {
  it('宣言していないフィールドを外へ出さない', async () => {
    const app = buildApp({}, { leakAccountField: true });

    const claimed = await loginThrough(app);
    expect(JSON.stringify(claimed)).not.toContain('leakedField');

    await app.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });

    const auth = { authorization: `Bearer ${claimed.token}` };
    const me = await (await app.request('/auth/me', { headers: auth })).json();
    expect(JSON.stringify(me)).not.toContain('leakedField');

    const access = await (await app.request('/access', { headers: OPERATOR })).json();
    expect(JSON.stringify(access)).not.toContain('leakedField');
  });

  it('宣言したフィールドは載る', async () => {
    const app = buildApp();
    const claimed = await loginThrough(app);
    await app.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });

    const access = (await (await app.request('/access', { headers: OPERATOR })).json()) as {
      accounts: Record<string, unknown>[];
    };
    const account = access.accounts.find((entry) => entry.id === claimed.account.id);
    expect(account).toBeDefined();
    expect(account).toHaveProperty('granted', true);
    expect(account).toHaveProperty('identities');
    expect(Array.isArray((account as { identities: unknown[] }).identities)).toBe(true);
    expect(account).toHaveProperty('email');
    expect(account).toHaveProperty('grantedAt');
    expect(account).toHaveProperty('grantedBy');

    const auth = { authorization: `Bearer ${claimed.token}` };
    const me = (await (await app.request('/auth/me', { headers: auth })).json()) as {
      kind: string;
      granted: boolean;
      account: Record<string, unknown>;
    };
    expect(me.granted).toBe(true);
    expect(me.account).toHaveProperty('email');
    expect(me.account).toHaveProperty('grantedAt');
  });

  it('応答のキー集合が宣言のキー集合と一致する', async () => {
    const app = buildApp();
    const claimed = await loginThrough(app);
    await app.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });

    const access = (await (await app.request('/access', { headers: OPERATOR })).json()) as {
      accounts: Record<string, unknown>[];
    };
    const account = access.accounts.find((entry) => entry.id === claimed.account.id);
    expect(account).toBeDefined();

    const declaredKeys = Object.keys(accountWithIdentitiesSchema.shape).sort();
    const actualKeys = Object.keys(account as Record<string, unknown>).sort();
    expect(actualKeys).toEqual(declaredKeys);
  });
});

// 文言は `app.ts` から import せずここへ複製する: import すると、文言がずれても歯まで一緒にずれて自己整合し、ずれを検出できなくなるため。
describe('許可済みのアカウントは宣言の有無にかかわらず /credentials /reset /mcp-servers を通る（#2862）。宣言の口は operator のまま', () => {
  const NOT_OPERATOR_ERROR = '実行環境の持ち主だけが操作できる';

  function buildAppWithVault() {
    stores = createMemoryStores();
    nextSubject = 'sub-1';
    const resolved: AuthPlan = {
      enabled: true,
      providers: [FAKE_PROVIDER],
      publicBaseUrl: 'http://127.0.0.1:4517',
      tokenTtlDays: 30,
      description: 'テスト',
    };
    return createApp({
      clone: stubClone(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      credentials: createCredentialService({ stores, withheldEnvKeys: [] }),
      auth: {
        plan: resolved,
        service: createAuthService({
          store: stores.auth,
          providers: createAuthProviderRegistry(resolved.providers),
        }),
      },
    });
  }

  let vaultApp: ReturnType<typeof createApp>;

  beforeEach(() => {
    vaultApp = buildAppWithVault();
  });

  const putCredential = (headers: Record<string, string>) =>
    vaultApp.request('/credentials', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ credentials: [{ name: 'GIT_AUTHOR_NAME', value: 'takecchi' }] }),
    });

  const postReset = (headers: Record<string, string>) =>
    vaultApp.request('/reset', {
      ...post,
      headers: { ...post.headers, ...headers },
      body: JSON.stringify({ confirm: true }),
    });

  const postOwner = (accountId: string, headers: Record<string, string>) =>
    vaultApp.request(`/access/${accountId}/owner`, {
      ...post,
      headers: { ...post.headers, ...headers },
    });

  const postOwnerRevoke = (accountId: string, headers: Record<string, string>) =>
    vaultApp.request(`/access/${accountId}/owner/revoke`, {
      ...post,
      headers: { ...post.headers, ...headers },
    });

  async function grantedAccount(): Promise<{ token: string; accountId: string }> {
    const claimed = await loginThrough(vaultApp);
    const granted = await vaultApp.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    expect(granted.status).toBe(200);
    return { token: claimed.token, accountId: claimed.account.id };
  }

  async function ownerToken(): Promise<{ token: string; accountId: string }> {
    const account = await grantedAccount();
    const declared = await postOwner(account.accountId, OPERATOR);
    expect(declared.status).toBe(200);
    const body = (await declared.json()) as { account: { ownerDeclaredAt: string | null } };
    expect(body.account.ownerDeclaredAt).not.toBeNull();
    return account;
  }

  it('① 宣言済み owner は PUT /credentials を通る（200）', async () => {
    const owner = await ownerToken();
    const response = await putCredential({ authorization: `Bearer ${owner.token}` });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { credentials: { name: string }[] };
    expect(body.credentials.map((entry) => entry.name)).toEqual(['GIT_AUTHOR_NAME']);
  });

  it('① 宣言済み owner は POST /reset を通る（200）', async () => {
    const owner = await ownerToken();
    const response = await postReset({ authorization: `Bearer ${owner.token}` });
    expect(response.status).toBe(200);
  });

  it('① 実行環境の持ち主そのものは今日どおり通る（能力を消したのではない）', async () => {
    expect((await putCredential({ ...OPERATOR })).status).toBe(200);
    expect((await postReset({ ...OPERATOR })).status).toBe(200);
  });

  it('② 資格が無ければ 401 のまま（門を足したことが未ログインへ漏れていない）', async () => {
    expect((await putCredential({})).status).toBe(401);
    expect((await postReset({})).status).toBe(401);
  });

  it('② ログインしただけ（未許可）は 403 のまま', async () => {
    const claimed = await loginThrough(vaultApp);
    const auth = { authorization: `Bearer ${claimed.token}` };
    expect((await putCredential(auth)).status).toBe(403);
    expect((await postReset(auth)).status).toBe(403);
  });

  it('② 宣言していない許可済みアカウントも通る（#2862: ログインできる許可済みは全員持ち主）', async () => {
    const account = await grantedAccount();
    const auth = { authorization: `Bearer ${account.token}` };

    expect((await vaultApp.request('/memory', { headers: auth })).status).toBe(200);
    expect((await putCredential(auth)).status).toBe(200);
    expect((await postReset(auth)).status).toBe(200);
  });

  it('③ 許可が伝播したアカウント（別のアカウントが通した）も通る（#2862）', async () => {
    const owner = await ownerToken();

    nextSubject = 'sub-2';
    const second = await loginThrough(vaultApp);
    const granted = await vaultApp.request(`/access/${second.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, authorization: `Bearer ${owner.token}` },
    });
    expect(granted.status).toBe(200);

    const auth = { authorization: `Bearer ${second.token}` };
    expect((await putCredential(auth)).status).toBe(200);
    expect((await postReset(auth)).status).toBe(200);
  });

  it('⑥ 許可を取り消すと宣言も落ち（取り消し中は 403）、再 grant しても宣言は戻らない', async () => {
    const owner = await ownerToken();
    const revoked = await vaultApp.request(`/access/${owner.accountId}/revoke`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    expect(revoked.status).toBe(200);
    const revokedBody = (await revoked.json()) as { account: { ownerDeclaredAt: string | null } };
    expect(revokedBody.account.ownerDeclaredAt).toBeNull();

    const auth = { authorization: `Bearer ${owner.token}` };
    expect((await putCredential(auth)).status).toBe(403);
    expect((await postReset(auth)).status).toBe(403);

    const regranted = await vaultApp.request(`/access/${owner.accountId}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    expect(regranted.status).toBe(200);
    const regrantedBody = (await regranted.json()) as {
      account: { ownerDeclaredAt: string | null };
    };
    expect(regrantedBody.account.ownerDeclaredAt).toBeNull();
    expect((await putCredential(auth)).status).toBe(200);
  });

  const putMcpServers = (headers: Record<string, string>) =>
    vaultApp.request('/mcp-servers', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }),
    });

  it('① 宣言済み owner は GET / PUT /mcp-servers を通る（200）', async () => {
    const owner = await ownerToken();
    const auth = { authorization: `Bearer ${owner.token}` };
    expect((await putMcpServers(auth)).status).toBe(200);
    const read = await vaultApp.request('/mcp-servers', { headers: auth });
    expect(read.status).toBe(200);
    const body = (await read.json()) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(body.mcpServers)).toEqual(['github']);
  });

  it('② 宣言していない許可済みアカウントも GET / PUT /mcp-servers を通る（#2862）', async () => {
    const account = await grantedAccount();
    const auth = { authorization: `Bearer ${account.token}` };
    expect((await putMcpServers(auth)).status).toBe(200);
    expect((await vaultApp.request('/mcp-servers', { headers: auth })).status).toBe(200);
  });

  it('② 許可の無い（ログインしただけの）アカウントは /mcp-servers に触れない（403）', async () => {
    const claimed = await loginThrough(vaultApp);
    const auth = { authorization: `Bearer ${claimed.token}` };
    expect((await vaultApp.request('/mcp-servers', { headers: auth })).status).toBe(403);
    expect((await putMcpServers(auth)).status).toBe(403);
    expect(await stores.mcpServers.read()).toBeNull();
  });

  it('① 実行環境の持ち主そのものは /mcp-servers を通る。未ログインは 401', async () => {
    expect((await putMcpServers({ ...OPERATOR })).status).toBe(200);
    expect((await vaultApp.request('/mcp-servers', { headers: OPERATOR })).status).toBe(200);
    expect((await vaultApp.request('/mcp-servers')).status).toBe(401);
    expect((await putMcpServers({})).status).toBe(401);
  });

  it('④ /profile は宣言済み owner なら通る（2026-09-24 に requireOwner へ移した）', async () => {
    const owner = await ownerToken();
    const auth = { authorization: `Bearer ${owner.token}` };

    const read = await vaultApp.request('/profile', { headers: auth });
    expect(read.status).toBe(200);

    expect(
      (
        await vaultApp.request('/profile', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ script: 'env' }),
        })
      ).status,
    ).not.toBe(403);

    expect((await vaultApp.request('/profile', { headers: OPERATOR })).status).toBe(200);
  });

  describe('⑦ owner 宣言の口そのものは account トークンで叩けない（非伝播）', () => {
    it('宣言していないアカウントの token では POST /access/:id/owner が 403', async () => {
      const account = await grantedAccount();
      const auth = { authorization: `Bearer ${account.token}` };
      const response = await postOwner(account.accountId, auth);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: NOT_OPERATOR_ERROR });
    });

    it('宣言済み owner 自身の token でも POST /access/:id/owner が 403（自己昇格も含めて非伝播）', async () => {
      const owner = await ownerToken();
      nextSubject = 'sub-2';
      const second = await loginThrough(vaultApp);
      await vaultApp.request(`/access/${second.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });

      const auth = { authorization: `Bearer ${owner.token}` };
      const response = await postOwner(second.account.id, auth);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: NOT_OPERATOR_ERROR });
    });

    it('account token では POST /access/:id/owner/revoke も 403', async () => {
      const owner = await ownerToken();
      const auth = { authorization: `Bearer ${owner.token}` };
      const response = await postOwnerRevoke(owner.accountId, auth);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: NOT_OPERATOR_ERROR });
    });

    it('未ログインでは POST /access/:id/owner が 401', async () => {
      const account = await grantedAccount();
      expect((await postOwner(account.accountId, {})).status).toBe(401);
    });
  });

  it('operator が未許可のアカウントへ宣言しようとすると 409（宣言は許可済みの行にしか立たない）', async () => {
    const claimed = await loginThrough(vaultApp);
    const response = await postOwner(claimed.account.id, OPERATOR);
    expect(response.status).toBe(409);
  });
});

describe('開いている SSE の資格の確かめ直し（issue #1820）', () => {
  const HEARTBEAT_MS = 10;

  async function readUntilEnd(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<{ done: boolean; text: string }> {
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const result = await reader.read();
      if (result.done) return { done: true, text };
      text += decoder.decode(result.value, { stream: true });
    }
  }

  async function readUntilText(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    needle: string,
  ): Promise<{ done: boolean; text: string }> {
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(needle)) {
      const result = await reader.read();
      if (result.done) return { done: true, text };
      text += decoder.decode(result.value, { stream: true });
    }
    return { done: false, text };
  }

  // 壁時計の窓を残す: 外すと、閉じない流れを永久に待つため。
  async function readForWindow(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    windowMs: number,
  ): Promise<{ done: boolean; text: string }> {
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + windowMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { done: false, text };
      const result = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining)),
      ]);
      if (result === 'timeout') return { done: false, text };
      if (result.done) return { done: true, text };
      text += decoder.decode(result.value, { stream: true });
    }
  }

  async function grantedLogin(app: ReturnType<typeof createApp>) {
    const claimed = await loginThrough(app);
    await app.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    return claimed;
  }

  async function openJournal(app: ReturnType<typeof createApp>, headers: Record<string, string>) {
    const response = await app.request('/journal/stream', { headers });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await readUntilText(reader, 'event: open');
    expect(first.text).toContain('event: open');
    return reader;
  }

  it('journal: ログアウトした後の心拍で、流れが閉じる', async () => {
    const app = buildApp({}, { sseHeartbeatMs: HEARTBEAT_MS });
    const claimed = await grantedLogin(app);
    const auth = { authorization: `Bearer ${claimed.token}` };
    const reader = await openJournal(app, auth);

    const logout = await app.request('/auth/logout', {
      ...post,
      headers: { ...post.headers, ...auth },
    });
    expect(logout.status).toBe(200);

    expect((await readUntilEnd(reader)).done).toBe(true);
  });

  it('journal: アカウントの許可を取り消した後の心拍で、流れが閉じる', async () => {
    const app = buildApp({}, { sseHeartbeatMs: HEARTBEAT_MS });
    const claimed = await grantedLogin(app);
    const reader = await openJournal(app, { authorization: `Bearer ${claimed.token}` });

    const revoked = await app.request(`/access/${claimed.account.id}/revoke`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    expect(revoked.status).toBe(200);

    expect((await readUntilEnd(reader)).done).toBe(true);
  });

  it('chat: ログアウトした後の心拍で、理由を error イベントで伝えてから閉じる', async () => {
    const app = buildApp({}, { sseHeartbeatMs: HEARTBEAT_MS });
    const claimed = await grantedLogin(app);
    const auth = { authorization: `Bearer ${claimed.token}` };
    const response = await app.request('/chat', {
      ...post,
      headers: { ...post.headers, ...auth },
      body: JSON.stringify({ text: 'こんにちは' }),
    });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    expect((await readUntilText(reader, 'event: open')).text).toContain('event: open');

    await app.request('/auth/logout', { ...post, headers: { ...post.headers, ...auth } });

    const rest = await readUntilEnd(reader);
    expect(rest.done).toBe(true);
    expect(rest.text).toContain('event: error');
    expect(rest.text).toContain('資格が使えなくなった');
    expect(rest.text).not.toContain(claimed.token);
  });

  it('chat/stream: ログアウトした後の心拍で、理由を error イベントで伝えてから閉じる（Issue #2652）', async () => {
    const app = buildApp({}, { sseHeartbeatMs: HEARTBEAT_MS });
    const claimed = await grantedLogin(app);
    const auth = { authorization: `Bearer ${claimed.token}` };
    const response = await app.request('/chat/conv-a/stream', { headers: auth });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    expect((await readUntilText(reader, 'event: thinking')).text).toContain('event: thinking');

    await app.request('/auth/logout', { ...post, headers: { ...post.headers, ...auth } });

    const rest = await readUntilEnd(reader);
    expect(rest.done).toBe(true);
    expect(rest.text).toContain('event: error');
    expect(rest.text).toContain('資格が使えなくなった');
    expect(rest.text).not.toContain(claimed.token);
  });

  it('対照: ログアウトしなければ、心拍が何度来ても流れは開いたまま', async () => {
    const app = buildApp({}, { sseHeartbeatMs: HEARTBEAT_MS });
    const claimed = await grantedLogin(app);
    const reader = await openJournal(app, { authorization: `Bearer ${claimed.token}` });

    const result = await readForWindow(reader, 200);
    expect(result.done).toBe(false);
    expect(result.text).toContain(': hb');
    await reader.cancel();
  });

  it('operator の資格で張った流れは、確かめ直さない（いままでどおり開いたまま）', async () => {
    const app = buildApp({}, { sseHeartbeatMs: HEARTBEAT_MS });
    const reader = await openJournal(app, OPERATOR);

    const result = await readForWindow(reader, 200);
    expect(result.done).toBe(false);
    await reader.cancel();
  });
});

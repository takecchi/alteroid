import type { AuthAccount, CloneHost, ManagerPool, OAuthProvider, Stores } from '@alteroid/core';
import { createAuthProviderRegistry, createAuthService, createMemoryStores } from '@alteroid/core';
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

/**
 * 入口の認証（「誰がこの API を叩いているか」）。
 *
 * ここで固定したいのは、**能力の削除ではなく境界であること**の実装上の帰結である。
 * ①設定していなければ従来どおり通る（境界の導入がデグレードにならない）
 * ②ログインしただけでは通らない（許可は人間が別に与える）
 * ③許可を与える口は実行環境の持ち主だけが叩ける（最初の1人の出口）
 */

function stubClone(): CloneHost {
  const managers: ManagerPool = {
    start: () => Promise.reject(new Error('起こさない')),
    send: () => Promise.reject(new Error('送らない')),
    abort: () => Promise.reject(new Error('止めない')),
    list: () => Promise.resolve([]),
    denials: () => [],
    // 認証境界の検証では触らない（`GET /runners` は `deps.runners` を直に読み、
    // ここは経由しない）。型を満たすだけの空スタブで足りる。
    runners: () =>
      Promise.resolve({ runners: [], unassigned: [], daemonRevision: { status: 'unknown' } }),
    transcript: () => Promise.resolve(null),
    restore: () => Promise.resolve([]),
    stop: () => Promise.resolve(),
  };
  return {
    managers,
    post: () => 'conversation-1',
    subscribe: () => () => undefined,
    endConversation: () => Promise.resolve(),
    answerApproval: () => Promise.resolve(true),
    stop: () => Promise.resolve(),
  } as unknown as CloneHost;
}

/** 誰としてログインするかをテスト側から切り替える（2人目を作るため）。 */
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

/**
 * `stores.auth` を包み、アカウントを返すメソッドへ宣言に無いフィールドを混ぜる。
 *
 * **`listAccounts`（`/access` が読む）と `getAccount`（`authenticate` と `claim` が
 * ここを通ってアカウントを引く）の2つだけを包む。** `AuthStore` の他のメソッド
 * （`findAccountByEmail` / `grantExclusive` など）は今回の対象経路
 * （`/auth/me` `/auth/login/:id/claim` `/access`）がアカウントを読むために通る道
 * ではないので、包んでも混ざらない。
 */
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

function buildApp(plan: Partial<AuthPlan> = {}, options: { leakAccountField?: boolean } = {}) {
  stores = createMemoryStores();
  nextSubject = 'sub-1';
  if (options.leakAccountField === true) {
    // **`authService` は包んだ後の `stores.auth` から作ること。** そうしないと
    // `/auth/me` と claim には効かない（authService が別の生の store を握ったまま
    // になる）。
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
    auth: {
      plan: resolved,
      service: createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry(resolved.providers),
      }),
    },
  });
}

/** ログインを最後まで通して、アカウントとトークンを得る。 */
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
  });

  it('/health と /auth/* は資格が無くても読める（ログインの前に通る必要がある）', async () => {
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/auth/providers')).status).toBe(200);
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
    // 401 ではない。やり直しても解決せず、人間の操作が要ることを区別して伝える。
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
    // トークンは消していないのに通らない（消し忘れが生き残らない）。
    expect((await app.request('/memory', { headers: auth })).status).toBe(403);
  });

  it('許可の付与は実行環境の持ち主だけができる（許可された利用者でも 403）', async () => {
    const claimed = await loginThrough(app);
    await app.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });

    // 自分で自分を通せてしまうと、境界が成り立たない。
    const response = await app.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, authorization: `Bearer ${claimed.token}` },
    });
    expect(response.status).toBe(403);
    expect(
      (await app.request('/access', { headers: { authorization: `Bearer ${claimed.token}` } }))
        .status,
    ).toBe(403);
  });

  it('実行環境プロファイルは持ち主だけ（許可された利用者でも 403）', async () => {
    // **ここは「alteroid を使ってよい」より一段強い口である。**
    //
    // `PUT` の本文はデーモンの `process.env` を土台にその場で評価される ＝
    // 記憶ストアの鍵を持つプロセスでの任意コマンド実行であり、評価中の出力は
    // 応答にも返る（本文に `env` と1行書けば `ALTEROID_DATABASE_URL` も
    // 制御面の合鍵も読める）。`GET` も同じ扱いにする — 本文には `GH_TOKEN` の
    // ような鍵が丸ごと入りうるので、読み側が緩ければ書き側を締めても意味が無い。
    const claimed = await loginThrough(app);
    await app.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    const auth = { authorization: `Bearer ${claimed.token}` };

    // 許可されている ＝ 記憶には触れる
    expect((await app.request('/memory', { headers: auth })).status).toBe(200);

    // それでもプロファイルには触れない
    expect((await app.request('/profile', { headers: auth })).status).toBe(403);
    expect(
      (
        await app.request('/profile', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ script: 'env' }),
        })
      ).status,
    ).toBe(403);

    // 実行環境の持ち主は通る（境界を入れて能力を消したのではない）
    expect((await app.request('/profile', { headers: OPERATOR })).status).toBe(200);
  });

  it('許可できるアカウントは高々1つ（2人目の grant は 409）', async () => {
    const first = await loginThrough(app);
    nextSubject = 'sub-2';
    const second = await loginThrough(app);
    expect(second.account.id).not.toBe(first.account.id);

    const grantFirst = await app.request(`/access/${first.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    expect(grantFirst.status).toBe(200);

    // ここを 200 にすると、ログインした人数だけ同じクローンの記憶・日誌・実行 API が
    // 開く＝そのままマルチユーザー利用になる（PRD 非ゴール）。
    const grantSecond = await app.request(`/access/${second.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    expect(grantSecond.status).toBe(409);
    expect(
      (await app.request('/memory', { headers: { authorization: `Bearer ${second.token}` } }))
        .status,
    ).toBe(403);

    // 先に取り消せば移せる（持ち主の付け替えはできる）。
    await app.request(`/access/${first.account.id}/revoke`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    expect(
      (
        await app.request(`/access/${second.account.id}/grant`, {
          ...post,
          headers: { ...post.headers, ...OPERATOR },
        })
      ).status,
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
});

/**
 * `/auth/*` `/access/*` の応答が、宣言（`openapi.ts` のスキーマ）どおりであること。
 *
 * `describeRoute` の `resolver()` は `openapi.json` を作るだけでハンドラの戻り値を
 * 検査しない。だから応答は返す前に必ず宣言スキーマの `.parse()` を通す
 * （`app.ts` の該当7箇所）。ここではそれが実際に効いていることを、本物のハンドラを
 * 本物の経路で叩いて確かめる。
 */
describe('宣言と実物の一致（/auth・/access）', () => {
  it('宣言していないフィールドを外へ出さない', async () => {
    // `stores.auth` がアカウントへ余計なキーを混ぜて返す状態を作る。
    // **「宣言どおりのものが出る」だけを見ない** — それだけでは `.parse()` を
    // 外しても通ってしまう。ここでは応答本文のどこにも現れないことを見る。
    const app = buildApp({}, { leakAccountField: true });

    const claimed = await loginThrough(app);
    expect(JSON.stringify(claimed)).not.toContain('leakedField');

    // `/auth/me` の account 枝は許可されたアカウントでなければ門番（403）で
    // 止まり、ハンドラへ届かない。届かせるために先に許可する。
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
    // **これは「宣言だけ消す」変異で落ちる歯である。** 前のテストは「余計なものが
    // 出ないこと」しか見ていないので、宣言ごと削っても気づけない。
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
    // **これは「`.parse()` を外し、かつ宣言も消す」変異で落ちる歯である。**
    // `.parse()` があれば宣言に無いキーは落ちるが、`.parse()` ごと外すと
    // 実物（ドメインの値）のキーがそのまま出る。宣言のキー集合そのものと
    // 突き合わせて一致を見る。
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

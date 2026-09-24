import type { AuthAccount, CloneHost, ManagerPool, OAuthProvider, Stores } from '@alteroid/core';
import {
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

/**
 * 入口の認証（「誰がこの API を叩いているか」）。
 *
 * ここで固定したいのは、**能力の削除ではなく境界であること**の実装上の帰結である。
 * ①設定していなければ従来どおり通る（境界の導入がデグレードにならない）
 * ②ログインしただけでは通らない（許可は人間が別に与える）
 * ③**⚠️ 2026-09-06 のオーナー決定で変わった**——`/access/*` は `authenticate` だけに
 * なり、alteroid を使う許可（`access grant` 済み）があれば実行環境の持ち主と同格に
 * 叩ける。最初の1人（誰も許可されていない状態からの grant）は依然として実行環境の
 * 持ち主にしか通せない——**許可されたアカウントという資格が、まだ1つも存在しない
 * からである**（`isAccountGranted` が全員 false を返す。2026-09-09 に許可の上限を
 * 外した後もここは変わらない。以前この括弧には「`grantExclusive` が持ち主の不在を
 * 検査してから書く1操作であることの帰結」と書いてあったが、**それは理由ではなかった**
 * ——検査を外したいまも同じ性質が残っている）。この対比は下の describe が固定する。
 * `/profile` は変えていない
 * （鍵をまるごと運ぶ口。理由は `app.ts` の `requireOperator` 呼び出し箇所の doc）。
 */

function stubClone(): CloneHost {
  const managers: ManagerPool = {
    start: () => Promise.reject(new Error('起こさない')),
    send: () => Promise.reject(new Error('送らない')),
    abort: () => Promise.reject(new Error('止めない')),
    appraise: () => Promise.reject(new Error('評定しない')),
    list: () => Promise.resolve([]),
    denials: () => [],
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    // 認証境界の検証では触らない（`GET /runners` は `deps.runners` を直に読み、
    // ここは経由しない）。型を満たすだけの空スタブで足りる。
    runners: () =>
      Promise.resolve({ runners: [], unassigned: [], daemonRevision: { status: 'unknown' } }),
    // 認証境界の検証では触らない（`GET /runners` が直接呼ぶ。型を満たすだけの
    // 空スタブで足りる）。
    pushHealthOf: () => undefined,
    transcript: () => Promise.resolve({ kind: 'missing' as const }),
    // 認証境界の検証では触らない（#1039 の口は manager_stop からしか呼ばれない。
    // 型を満たすだけの空スタブで足りる）。
    unpushedWork: () =>
      Promise.resolve({ kind: 'unavailable' as const, reason: '(この検証では未使用)' }),
    runningManagerOwning: () => undefined,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    // 認証境界の検証では触らない（型を満たすだけの空スタブで足りる）。
    relocateFrom: () => undefined,
    vacate: () => Promise.resolve(),
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    settleStalledUsageWakes: () => Promise.resolve([]),
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
 * （`findAccountByEmail` / `grantAccess` など）は今回の対象経路
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

  /**
   * ⚠️ 2026-09-06、オーナー決定で反転した。以前はここで「許可の付与は実行環境の
   * 持ち主だけができる（許可された利用者でも 403）」を固定していた——`自分で
   * 自分を通せてしまうと、境界が成り立たない`という理由からで、`/access/:id/grant`
   * と `GET /access` は `requireOperator` を通っていた。
   *
   * いまは alteroid を使う許可（`access grant` 済み）を実行環境の持ち主と同格に
   * 扱う（`apps/daemon/src/app.ts` の `requireOperator` の doc）ので、この2経路は
   * `authenticate` だけになった。**「自分で自分を通せる」ことは、もう境界の
   * 崩壊ではない**——同一アカウントへの再 grant は冪等な `granted` を返すだけである。
   *
   * ⚠️ **ここに「別アカウントを追加で通せる訳ではない」と書いてあった。2026-09-09 の
   * オーナー決定で通せるようになった**（許可できるアカウントの上限が消えた）。
   * ⟹ **同格化と上限の撤去が揃って、いま初めて許可が伝播する**（A が B を、B が C を）。
   * どちらもオーナー決定なので戻さない。追える場所は日誌だけである
   * （下の「許可の付与と取り消しは日誌に残る」）。
   *
   * `/profile` はこの決定の対象外のままで、`403` を固定するテストは
   * 「実行環境プロファイルは宣言済み owner まで」に残る（2026-09-24 に門は
   * `requireOwner` へ移ったが、許可されただけのアカウントは今も 403）。
   */
  it('許可されたアカウントも実行環境の持ち主と同格——自分自身への再 grant も GET /access も通る', async () => {
    const claimed = await loginThrough(app);
    await app.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });

    // 既に許可済みの自分自身への grant は冪等に 200
    // （`grantAccess` は書き込まずに `granted` を返す）。
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

  /**
   * ⚠️ **2026-09-24（#1122）に門を `requireOperator` から `requireOwner` へ移した。**
   * 許可されただけ（宣言していない）のアカウントが 403 になることはこのまま固定し、
   * 403 の本文だけを `requireOwner` の文言へ反転した（宣言済み owner が通ることは
   * 上の ④ が撃つ）。下の長い注釈は移す前の理由として残す。
   */
  it('実行環境プロファイルは宣言済み owner まで（許可されただけの利用者は 403）', async () => {
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
    const forbidden = await app.request('/profile', { headers: auth });
    expect(forbidden.status).toBe(403);

    // **⭐ 本文まで固定する。** 2026-09-06 に `/tokens` と `/access/*` を「alteroid を
    // 使う許可」と同格にしたので、`requireOperator` の 403 を**産む経路はこの
    // `/profile` の2本と、下の owner 宣言の口2本（`POST /access/:accountId/owner`
    // / `.../owner/revoke`）だけである**（他は `authenticate` の「許可が無い」403 に
    // なる）。
    //
    // **⚠️ 2026-09-17〜18、`requireOwner` という別の門ができた**（issue #1195 で
    // `requireOperatorOrDirectGrant` として入り、issue #1198 で中身を差し替えて改名
    // した）。**この門の 403 の本文は `requireOperator` と1文字も違えていない
    // 旧設計から一転し、意図して別の文言にしてある**（`requireOwner` の doc）——
    // 「持ち主そのもの」と「持ち主として宣言されたアカウント」は別の状態で、CLI の
    // 案内も別になるため。⟹ **ここの本文はいまも `requireOperator` だけの生産物**
    // （下の describe「宣言済み owner は /credentials と /reset を通る」が、
    // `requireOwner` 側の別の文言を固定している）。
    //
    // そして CLI はこの本文を見て「デーモンと同じ器の中で実行してください」と案内を
    // 選ぶ（`apps/cli/src/target.ts` の `forbiddenKindOf`）。文言がずれると案内は
    // 「理由を判別できなかった」側へ黙って倒れる。
    //
    // **値はここへ複製してある。**`app.ts` から import すると、文言がずれても歯まで
    // 一緒にずれて自己整合し、ずれを検出できなくなる。
    expect(await forbidden.json()).toEqual({
      error: '実行環境の持ち主として宣言されたアカウントだけが操作できる',
    });
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

  /**
   * ⚠️ **2026-09-09 に期待値を反転した。** 反転前は「許可できるアカウントは高々1つ
   * （2人目の grant は 409）」で、本文にはこう書いてあった —— *「ここを 200 にすると、
   * ログインした人数だけ同じクローンの記憶・日誌・実行 API が開く＝そのまま
   * マルチユーザー利用になる（PRD 非ゴール）」*。
   *
   * **その帰結の記述は正しい。** オーナーが変えたのは、それを受け入れるかのほうである
   * （同じ人間が私用と仕事用の Google アカウントの両方から入れないことのほうが、実際の
   * 使い方に対する欠落だった）。PRD 側も同じ日に線を引き直してある —— 非ゴールが
   * 禁じているのは**利用者ごとにデータを分けること**で、入口の数ではない
   * （逐語は `grep -Fn -- '境界はデータの側に在る' docs/PRD.md`）。
   *
   * **保証は弱くなっていない。** 落ちたのは件数の上限で、代わりに
   * 「revoke が**名指しした1つだけ**を落とす」を測るようになった —— 上限が在った頃は
   * 許可が1つしか無いので、この形は測りようがなかった。
   */
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

    // 2人とも同じ1組のデータへ通る（分けていないのはここである）。
    for (const token of [first.token, second.token]) {
      expect(
        (await app.request('/memory', { headers: { authorization: `Bearer ${token}` } })).status,
      ).toBe(200);
    }

    // **revoke は名指しした1つだけを落とす。** ここが「全員落ちる」になっていると、
    // 1つ取り消したつもりで自分も締め出される。
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

  /**
   * **日誌の「誰が」は、叩いた principal から導かれること。**
   *
   * 2026-09-06 の同格化まで `/access/*` は `requireOperator` を通っていたので、
   * 「叩いた者＝実行環境の持ち主」が保証されており、固定の文言で正しかった。
   * **同格化でその保証が消えた。** 許可されたアカウントが叩いても「実行環境の
   * 持ち主による操作」と記録されるなら、事後に追えること（PRD「可観測性」）が
   * 記録の側から崩れる。
   *
   * **両側から測る。** 片側だけだと「常に持ち主の文言を出す」形へ倒しても
   * 気づかない。**文言は値をここへ複製してある**——`app.ts` から import すると
   * 自己整合して、ずれてもこの歯が落ちなくなる。
   */
  describe('日誌の「誰が」', () => {
    async function lastGrounds(): Promise<string> {
      // **既定の `order` は `desc`（新しい順）。** 先頭が最新である
      // （`packages/core/src/testing.ts` の `list`: 「既定 `desc` は従来どおり
      // push の逆順（新しい順）」）。**`at(-1)` は最古を取る**ので使わない。
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
      // **鳴ってはいけない側。** ここが持ち主の文言なら、記録が嘘をついている。
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

    /**
     * ⚠️ **この節の前提が 2026-09-09 に半分だけ崩れた。読み替えが要る。**
     *
     * ここにはこう書いてあった —— *「`grantedBy` の側は、①が書き換える経路がいまは
     * 無い」*。根拠は2つで、**片方はいまも成り立ち、片方は崩れた。**
     *
     * - **成り立つ**: 既に許可済みのアカウントへの再 grant は、`grantAccess` が
     *   **書き込まずに**既存の記録を返す（`packages/storage-fs/src/auth.ts` と
     *   `testing.ts` — `account.grantedAt !== null` なら `next: null`）
     * - **⚠️ 崩れた**: *「別のアカウントを追加で通そうとすれば 409（持ち主は高々1つ）」*
     *   —— 上限が消えたので、いまは通る
     *
     * ⟹ **①が `grantedBy` に値を書ける経路が生まれた**（許可されたアカウントが、
     * まだ許可されていない別のアカウントを通す）。**そして `actorOf` の分岐は
     * そのために在ったので、いま初めて本番で効き始めた。** ここの doc が
     * 「そのときここを読み直すこと」と言っていた、そのときである。
     *
     * だから歯を2本にした —— 冪等な再 grant では書き換わらないこと（前と同じ）と、
     * **伝播したときは通した側の id が残ること**（新しい形。日誌と `grantedBy` が
     * 伝播を追える唯一の場所なので、ここが `operator` 固定に戻ると追跡ごと消える）。
     */
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
      // **`operator` ではない。** ここが固定値なら、この欄は情報を運ばない
      // （`AuthAccount.grantedBy` の doc）——誰が伝播させたのか分からなくなる。
      expect(body.account.grantedBy).toBe(first.account.id);

      const grounds = await lastGrounds();
      expect(grounds).toContain(first.account.id);
      expect(grounds).not.toContain('実行環境の持ち主');
    });
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

/**
 * **宣言済み owner は、Web UI からも環境変数を置けるしリセットもできる**
 * （issue #1198。本来の形。`requireOwner`）。
 *
 * ## なぜこの describe が要るのか
 *
 * 人間（箱の持ち主）が Web UI から `PUT /credentials` と `POST /reset` を叩いて
 * 403 で弾かれた、という報告が出どころである（issue #1195）。**ブラウザは
 * `requireOperator` を*構造的に*通れない** —— ①（実行環境の持ち主）は「サーバ上の
 * ファイルを読めること」であって提示できる秘密ではないからである（`isOperator`）。
 * ⟹ Web UI にボタンは在るのに、押すと必ず 403 になっていた。
 *
 * **⚠️ この PR は #1195 が入れた近似（`grantedBy === 'operator'`）を置き換える。**
 * 近似は「持ち主が端末から直に許可した」という事実からの推測で、破れる条件を
 * 持っていた（issue #1198 本文）。ここでは `ownerDeclaredAt` という独立の欄を
 * operator トークンだけが立てる——**旗を持てる者は常にホストへ到達できる者に
 * 限られる**（`requireOwner` の doc）。
 *
 * ## 撃つ方向（歯を弱めないために、片方だけでは緩めすぎた事故を検出できない）
 *
 * ①宣言済み owner は**通る** ②宣言していない許可済みアカウントは**通らない**
 * （広げすぎていないことの対照） ③**伝播した許可（別のアカウントが通した）は
 * 通らない** ④`/profile` も宣言済み owner なら**通る**（2026-09-24 に
 * `requireOwner` へ移した。#1122。以前はここで「通らないまま（意図した非対称）」を
 * 撃っていた） ⑤未ログインは401・未許可は403 ⑥`revoke` の後は宣言も落ち、
 * 再 grant しても owner ではない ⑦**宣言の口そのもの
 * （`POST /access/:accountId/owner`）を account トークンで叩くと403**——非伝播の
 * 証拠で、この PR がいちばん守りたい軸なので厚めに撃つ。
 *
 * **②③がいちばん大事である。** ②が緩むと「許可されていれば誰でも owner」へ
 * 広がったことに誰も気づかない。③が緩むと、許可の伝播（A が B を、B が C を）が
 * そのまま owner 資格の伝播になる——旧近似が持っていた欠陥そのものである。
 *
 * **（2026-09-24 まで）④は「意図した非対称」の証拠だった。** `PUT /credentials` は**置けるが
 * 読み出せない**（一覧が返すのは指紋）。`GET /profile` は本文に鍵が丸ごと載る口で、
 * 2026-09-06 の同格化でも名指しで外された。⟹ ここが一緒に緩んだら、それは
 * この変更が線を踏み越えたということである。
 *
 * **本文まで固定するのは①ではなく②③の側である。** `requireOwner` の 403 は
 * `requireOperator` とは違えてある（`app.ts` の doc）——値はここへ複製してある
 * （import すると、文言がずれても歯まで一緒にずれて自己整合し、ずれを検出
 * できなくなる。CLI 側の複製は `apps/cli/src/target.ts` の `forbiddenKindOf`）。
 */
describe('宣言済み owner（ownerDeclaredAt）は /credentials と /reset を通る', () => {
  const NOT_OWNER_ERROR = '実行環境の持ち主として宣言されたアカウントだけが操作できる';
  const NOT_OPERATOR_ERROR = '実行環境の持ち主だけが操作できる';

  /**
   * `credentials` の器を渡した app。**渡さないと `PUT /credentials` は門を通った後で
   * 503 になる**（「置いていない」と「口が無い」を分けるため。`app.test.ts` の
   * 「器が無ければ 503」）——それでは「門を通ったこと」を 200 で示せない。
   */
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

  /** ログインさせ、許可した（まだ owner 宣言はしていない）アカウント。 */
  async function grantedAccount(): Promise<{ token: string; accountId: string }> {
    const claimed = await loginThrough(vaultApp);
    const granted = await vaultApp.request(`/access/${claimed.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    expect(granted.status).toBe(200);
    return { token: claimed.token, accountId: claimed.account.id };
  }

  /** ログイン・許可したうえで、operator が owner として宣言する。 */
  async function ownerToken(): Promise<{ token: string; accountId: string }> {
    const account = await grantedAccount();
    const declared = await postOwner(account.accountId, OPERATOR);
    expect(declared.status).toBe(200);
    // **前提を測っておく。** ここが埋まっていなければ、以下の①は
    // 「通った」ではなく「別の理由で通った」になる。
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

  /**
   * **⭐ この歯がいちばん大事である。** 「宣言済みアカウントだけが通る」が
   * 「許可されていれば誰でも通る」へ広がったときに鳴る唯一の場所である
   * （広げすぎていないことの陰性対照）。
   */
  it('② 宣言していない許可済みアカウントは 403 のまま（広げすぎていない）', async () => {
    const account = await grantedAccount();
    const auth = { authorization: `Bearer ${account.token}` };

    // alteroid は使える（記憶には触れる）——許可はされている。
    expect((await vaultApp.request('/memory', { headers: auth })).status).toBe(200);

    // それでも宣言していないので環境変数とリセットは通らない。
    const forbidden = await putCredential(auth);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: NOT_OWNER_ERROR });
    expect((await postReset(auth)).status).toBe(403);
  });

  /**
   * **旧近似（`grantedBy === 'operator'`）が壊れていた条件そのもの。** `grantedBy`
   * を1箇所も読まない実装なら、ここは自動的に通る——読んでいたら伝播した相手が
   * 「端末から直に許可された」と誤認されうる。
   */
  it('③ 許可が伝播したアカウント（別のアカウントが通した）は 403（旧近似が広がっていた条件）', async () => {
    const owner = await ownerToken();

    nextSubject = 'sub-2';
    const second = await loginThrough(vaultApp);
    const granted = await vaultApp.request(`/access/${second.account.id}/grant`, {
      ...post,
      headers: { ...post.headers, authorization: `Bearer ${owner.token}` },
    });
    expect(granted.status).toBe(200);
    const grantedBody = (await granted.json()) as { account: { grantedBy: string | null } };
    // 前提: 伝播した許可である（`operator` ではなく、通したアカウントの id）。
    expect(grantedBody.account.grantedBy).toBe(owner.accountId);

    const auth = { authorization: `Bearer ${second.token}` };
    // alteroid は使える（記憶には触れる）。
    expect((await vaultApp.request('/memory', { headers: auth })).status).toBe(200);

    // それでも環境変数とリセットは通らない。
    const forbidden = await putCredential(auth);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: NOT_OWNER_ERROR });
    expect((await postReset(auth)).status).toBe(403);
  });

  it('⑥ 許可を取り消すと宣言も落ち、再 grant しても owner ではない', async () => {
    const owner = await ownerToken();
    const revoked = await vaultApp.request(`/access/${owner.accountId}/revoke`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    expect(revoked.status).toBe(200);
    const revokedBody = (await revoked.json()) as { account: { ownerDeclaredAt: string | null } };
    expect(revokedBody.account.ownerDeclaredAt).toBeNull();

    const auth = { authorization: `Bearer ${owner.token}` };
    // ここは `authenticate` の「許可が無い」403 に落ちる（門より手前）。
    expect((await putCredential(auth)).status).toBe(403);
    expect((await postReset(auth)).status).toBe(403);

    // 再 grant しても owner には戻らない（宣言は明示的な行為でしか立たない）。
    const regranted = await vaultApp.request(`/access/${owner.accountId}/grant`, {
      ...post,
      headers: { ...post.headers, ...OPERATOR },
    });
    expect(regranted.status).toBe(200);
    const regrantedBody = (await regranted.json()) as {
      account: { ownerDeclaredAt: string | null };
    };
    expect(regrantedBody.account.ownerDeclaredAt).toBeNull();
    expect((await putCredential(auth)).status).toBe(403);
  });

  /**
   * **MCP サーバの登録（#325 段1）は `PUT /credentials` と同じ段に置いた。**
   * 3方向を撃つ —— 宣言済み owner は通る／宣言していない許可済みアカウントは
   * 通らない（広げすぎていない）／持ち主そのものは通る。**読み側も同じ門である**
   * —— 登録の `env` / `headers` に鍵が丸ごと入りうるので、`GET` が緩いと `PUT`
   * を締めても意味が無い（`/profile` と同じ理由）。
   */
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

  it('② 宣言していない許可済みアカウントは GET / PUT /mcp-servers とも 403', async () => {
    const account = await grantedAccount();
    const auth = { authorization: `Bearer ${account.token}` };
    expect((await vaultApp.request('/memory', { headers: auth })).status).toBe(200);

    const forbidden = await vaultApp.request('/mcp-servers', { headers: auth });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: NOT_OWNER_ERROR });
    expect((await putMcpServers(auth)).status).toBe(403);
    // 弾いた側は何も置いていない。
    expect(await stores.mcpServers.read()).toBeNull();
  });

  it('① 実行環境の持ち主そのものは /mcp-servers を通る。未ログインは 401', async () => {
    expect((await putMcpServers({ ...OPERATOR })).status).toBe(200);
    expect((await vaultApp.request('/mcp-servers', { headers: OPERATOR })).status).toBe(200);
    expect((await vaultApp.request('/mcp-servers')).status).toBe(401);
    expect((await putMcpServers({})).status).toBe(401);
  });

  /**
   * ⚠️ **反転させた歯（2026-09-24、#1122）。** 以前は「④ /profile は宣言済み owner でも
   * 403 のまま（意図した非対称）」として、宣言済み owner の GET/PUT が
   * `requireOperator` の 403（`NOT_OPERATOR_ERROR`）で落ちることを固定していた。
   *
   * **なぜ反転したか。** ブラウザは `requireOperator` を構造的に通れないので、Web UI に
   * プロファイルの画面を置いても誰も開けなかった（#1122「入口の等価性の穴」）。人間へ
   * 上げ、オーナーが `requireOwner` へ移すと決めた（`docs/architecture.md` も同じ PR で
   * 直した）。
   *
   * **なぜ保証が弱くなっていないか。** 緩めたのは「宣言済み owner」の1段だけで、
   * 宣言していない許可済みアカウント・伝播した許可が通らないことは、下の
   * 「実行環境プロファイルは宣言済み owner まで」と ②③ がそのまま固定している。
   * この歯も消さず、「宣言済み owner は通る」側を撃つ形へ反転した。
   */
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

    // 実行環境の持ち主は今日どおり読める（締めたのではなく、緩めなかっただけである）。
    expect((await vaultApp.request('/profile', { headers: OPERATOR })).status).toBe(200);
  });

  /**
   * **⑦ この PR がいちばん守りたい軸。** 宣言の口そのもの
   * （`POST /access/:accountId/owner` `.../owner/revoke`）は `requireOperator`
   * ——account トークンでは、たとえ owner 本人でも叩けない。ここが緩むと
   * 「宣言は operator だけが立てられる旗」という前提そのものが崩れる。
   */
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

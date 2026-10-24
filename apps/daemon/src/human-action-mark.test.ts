import type {
  AuthAccount,
  CloneHost,
  JournalEntry,
  ManagerSendResult,
  Stores,
} from '@alteroid/core';
import { createAuthProviderRegistry, createAuthService, createMemoryStores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp, humanActionOf } from './app.js';
import type { AuthPlan } from './auth.js';

// 日誌の `decision.humanAction`（人間が API から直接した操作の印）を、5つの口ごとに測る。
// 印は「人間がした」の証拠ではなく、どの口から来たかの記録（`via`）である。

const OPERATOR = { authorization: 'Bearer operator-token' };
const JSON_HEADERS = { 'content-type': 'application/json' };

const FAKE_PROVIDER = {
  kind: 'oauth2' as const,
  id: 'fake',
  label: 'Fake',
  authorizationUrl: (request: { state: string }) =>
    `https://example.test/authorize?state=${request.state}`,
  exchange: async () => ({
    subject: 'sub-human-action',
    email: 'sub-human-action@example.test',
    emailVerified: true,
    displayName: 'sub-human-action',
  }),
};

let stores: Stores;
let sendResult: ManagerSendResult;
let sends: { managerId: string; text: string }[];

function fakeClone(): CloneHost {
  return {
    post: () => 'conversation-1',
    subscribe: () => () => undefined,
    stop: () => Promise.resolve(),
    usageBlocked: false,
    managers: {
      list: () => Promise.resolve([]),
      send: (managerId: string, text: string) => {
        sends.push({ managerId, text });
        return Promise.resolve(sendResult);
      },
    },
  } as unknown as CloneHost;
}

// 認証を切った構成（`auth` を渡さない）。token を付けない呼び出しは `via.auth: 'disabled'`、付ければ `operator-token`
function buildPlainApp() {
  return createApp({
    clone: fakeClone(),
    stores,
    token: 'operator-token',
    shutdown: () => undefined,
  });
}

function buildAuthedApp() {
  const plan: AuthPlan = {
    enabled: true,
    providers: [FAKE_PROVIDER],
    publicBaseUrl: 'http://127.0.0.1:4517',
    tokenTtlDays: 30,
    description: 'テスト',
  };
  return createApp({
    clone: fakeClone(),
    stores,
    token: 'operator-token',
    shutdown: () => undefined,
    auth: {
      plan,
      service: createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry(plan.providers),
      }),
    },
  });
}

async function grantedAccountToken(
  app: ReturnType<typeof createApp>,
): Promise<{ headers: Record<string, string>; accountId: string }> {
  const started = (await (
    await app.request('/auth/login', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider: 'fake' }),
    })
  ).json()) as { requestId: string; authorizationUrl: string; claimSecret: string };
  const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
  await app.request(`/auth/fake/callback?code=any&state=${encodeURIComponent(state)}`);
  const claimed = (await (
    await app.request(`/auth/login/${started.requestId}/claim`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ claimSecret: started.claimSecret }),
    })
  ).json()) as { token: string; account: { id: string } };
  await app.request(`/access/${claimed.account.id}/grant`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...OPERATOR },
  });
  return {
    headers: { authorization: `Bearer ${claimed.token}` },
    accountId: claimed.account.id,
  };
}

async function decisions(): Promise<Extract<JournalEntry, { type: 'decision' }>[]> {
  const entries = await stores.journal.list({ types: ['decision'], order: 'asc' });
  return entries.flatMap((entry) => (entry.type === 'decision' ? [entry] : []));
}

function decisionWithGrounds(
  all: Extract<JournalEntry, { type: 'decision' }>[],
  grounds: string,
): Extract<JournalEntry, { type: 'decision' }> {
  const found = all.filter((entry) => entry.grounds === grounds);
  expect(found).toHaveLength(1);
  return found[0] as Extract<JournalEntry, { type: 'decision' }>;
}

async function versionOf(
  app: ReturnType<typeof createApp>,
  slug: string,
  headers: Record<string, string>,
): Promise<string> {
  const read = await app.request(`/practices/${slug}`, { headers });
  return ((await read.json()) as { version: string }).version;
}

const call = (headers: Record<string, string>, method: string, body?: unknown) => ({
  method,
  headers: { ...JSON_HEADERS, ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeEach(() => {
  stores = createMemoryStores();
  sendResult = { outcome: 'delivered', detail: '届けた' };
  sends = [];
});

describe('POST /commitments/:id/close の印', () => {
  async function open(): Promise<string> {
    const opened = await buildPlainApp().request(
      '/commitments',
      call({}, 'POST', { body: '日報の体裁を直す' }),
    );
    return ((await opened.json()) as { id: string }).id;
  }

  it.each([
    ['認証を切った構成', {}, { kind: 'operator', auth: 'disabled' }],
    ['持ち主のトークン', OPERATOR, { kind: 'operator', auth: 'operator-token' }],
  ])('%s: commitment_close と行の id と via が付く', async (_name, headers, via) => {
    const id = await open();
    const response = await buildPlainApp().request(
      `/commitments/${id}/close`,
      call(headers, 'POST', { reason: '直した' }),
    );
    expect(response.status).toBe(200);

    expect(decisionWithGrounds(await decisions(), '人間が直接 API から閉じた').humanAction).toEqual(
      { kind: 'commitment_close', target: id, via },
    );
  });

  it('アカウント経路: via に accountId が写る', async () => {
    const app = buildAuthedApp();
    const { headers, accountId } = await grantedAccountToken(app);
    const id = await open();
    const response = await app.request(
      `/commitments/${id}/close`,
      call(headers, 'POST', { reason: '直した' }),
    );
    expect(response.status).toBe(200);

    expect(decisionWithGrounds(await decisions(), '人間が直接 API から閉じた').humanAction).toEqual(
      { kind: 'commitment_close', target: id, via: { kind: 'account', accountId } },
    );
  });
});

describe('POST /commitments/:id/reopen の印', () => {
  // grounds は開き直す前の記録を後ろに続けるので、前方一致で1行に絞る
  function reopenDecision(all: Awaited<ReturnType<typeof decisions>>) {
    const found = all.filter((entry) => entry.grounds?.startsWith('人間が直接 API から開き直した'));
    expect(found).toHaveLength(1);
    return found[0] as (typeof all)[number];
  }

  async function openClosed(): Promise<string> {
    const app = buildPlainApp();
    const opened = await app.request(
      '/commitments',
      call({}, 'POST', { body: '日報の体裁を直す' }),
    );
    const id = ((await opened.json()) as { id: string }).id;
    await app.request(`/commitments/${id}/close`, call({}, 'POST', { reason: '直した' }));
    return id;
  }

  it.each([
    ['認証を切った構成', {}, { kind: 'operator', auth: 'disabled' }],
    ['持ち主のトークン', OPERATOR, { kind: 'operator', auth: 'operator-token' }],
  ])('%s: commitment_reopen と行の id と via が付く', async (_name, headers, via) => {
    const id = await openClosed();
    const response = await buildPlainApp().request(
      `/commitments/${id}/reopen`,
      call(headers, 'POST', { reason: 'まだ終わっていない' }),
    );
    expect(response.status).toBe(200);

    expect(reopenDecision(await decisions()).humanAction).toEqual({
      kind: 'commitment_reopen',
      target: id,
      via,
    });
  });

  it('アカウント経路: via に accountId が写る', async () => {
    const app = buildAuthedApp();
    const { headers, accountId } = await grantedAccountToken(app);
    const id = await openClosed();
    const response = await app.request(
      `/commitments/${id}/reopen`,
      call(headers, 'POST', { reason: 'まだ終わっていない' }),
    );
    expect(response.status).toBe(200);

    expect(reopenDecision(await decisions()).humanAction).toEqual({
      kind: 'commitment_reopen',
      target: id,
      via: { kind: 'account', accountId },
    });
  });
});

describe('DELETE /schedule/:kind の印', () => {
  async function put(kind: string): Promise<void> {
    await stores.schedules.put({
      kind,
      spec: { type: 'daily', at: '09:00' },
      request: 'open issue を見て進める',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
  }

  it.each([
    ['認証を切った構成', {}, { kind: 'operator', auth: 'disabled' }],
    ['持ち主のトークン', OPERATOR, { kind: 'operator', auth: 'operator-token' }],
  ])('%s: schedule_remove と kind と via が付く', async (_name, headers, via) => {
    await put('issue-round');
    const response = await buildPlainApp().request(
      '/schedule/issue-round',
      call(headers, 'DELETE'),
    );
    expect(response.status).toBe(200);

    expect(decisionWithGrounds(await decisions(), '人間が直接 API から外した').humanAction).toEqual(
      { kind: 'schedule_remove', target: 'issue-round', via },
    );
  });

  it('アカウント経路: via に accountId が写る', async () => {
    const app = buildAuthedApp();
    const { headers, accountId } = await grantedAccountToken(app);
    await put('issue-round');
    const response = await app.request('/schedule/issue-round', call(headers, 'DELETE'));
    expect(response.status).toBe(200);

    expect(decisionWithGrounds(await decisions(), '人間が直接 API から外した').humanAction).toEqual(
      {
        kind: 'schedule_remove',
        target: 'issue-round',
        via: { kind: 'account', accountId },
      },
    );
  });
});

describe('/practices/:slug の印', () => {
  const base = { kind: '日報', title: '題', content: '本文' };

  it.each([
    ['認証を切った構成', {}, { kind: 'operator', auth: 'disabled' }],
    ['持ち主のトークン', OPERATOR, { kind: 'operator', auth: 'operator-token' }],
  ])(
    '%s: DELETE は practice_remove と slug と via が付き、既存の target も残る',
    async (_n, headers, via) => {
      await stores.practices.write({ slug: 'to-remove', ...base });
      const app = buildPlainApp();
      const response = await app.request(
        `/practices/to-remove?ifMatch=${await versionOf(app, 'to-remove', headers)}`,
        call(headers, 'DELETE'),
      );
      expect(response.status).toBe(200);

      const entry = decisionWithGrounds(await decisions(), '人間が直接 API からやり方を消した');
      expect(entry.humanAction).toEqual({ kind: 'practice_remove', target: 'to-remove', via });
      expect(entry.target).toEqual({ kind: 'practice', slug: 'to-remove' });
    },
  );

  it.each([
    ['認証を切った構成', {}, { kind: 'operator', auth: 'disabled' }],
    ['持ち主のトークン', OPERATOR, { kind: 'operator', auth: 'operator-token' }],
  ])('%s: 既に在るやり方の PUT は practice_write が付く', async (_n, headers, via) => {
    await stores.practices.write({ slug: 'daily', ...base });
    const response = await buildPlainApp().request(
      '/practices/daily',
      call(headers, 'PUT', { ...base, content: '書き直した' }),
    );
    expect(response.status).toBe(200);

    // #5243: 日誌を先に書くので、印の無い先の行と、効いた後の印つきの行の2行になる（旧: 印つきの1行だけ。印つきの行の中身は変えていない）
    const [first, entry, ...rest] = await decisions();
    expect(rest).toEqual([]);
    expect(first).not.toHaveProperty('humanAction');
    expect(entry?.grounds).toContain('人間が直接 API からやり方を書き直した');
    expect(entry?.humanAction).toEqual({ kind: 'practice_write', target: 'daily', via });
    expect(entry?.target).toEqual({ kind: 'practice', slug: 'daily' });
  });

  it('アカウント経路: PUT・DELETE とも via に accountId が写る', async () => {
    const app = buildAuthedApp();
    const { headers, accountId } = await grantedAccountToken(app);
    await stores.practices.write({ slug: 'daily', ...base });
    expect(
      (await app.request('/practices/daily', call(headers, 'PUT', { ...base, content: '直した' })))
        .status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `/practices/daily?ifMatch=${await versionOf(app, 'daily', headers)}`,
          call(headers, 'DELETE'),
        )
      ).status,
    ).toBe(200);

    const via = { kind: 'account', accountId };
    // アカウントの発行・許可の decision が混ざるので、印の付いた行だけを見る
    const marks = (await decisions()).flatMap((entry) =>
      entry.humanAction === undefined ? [] : [entry.humanAction],
    );
    expect(marks).toEqual([
      { kind: 'practice_write', target: 'daily', via },
      { kind: 'practice_remove', target: 'daily', via },
    ]);
  });

  it('新しく置いた回（PUT で無かったものを作る）には付けない', async () => {
    const response = await buildPlainApp().request(
      '/practices/new-one',
      call(OPERATOR, 'PUT', base),
    );
    expect(response.status).toBe(200);

    const entry = decisionWithGrounds(
      await decisions(),
      '人間が直接 API から新しいやり方を器に置いた',
    );
    expect(entry).not.toHaveProperty('humanAction');
    expect(entry.target).toEqual({ kind: 'practice', slug: 'new-one' });
  });
});

describe('POST /managers/:id/messages の印', () => {
  const messageBody = { text: '続けて' };

  it.each([
    ['認証を切った構成', {}, { kind: 'operator', auth: 'disabled' }],
    ['持ち主のトークン', OPERATOR, { kind: 'operator', auth: 'operator-token' }],
  ])('%s: delivered なら manager_message と委譲の id と via が付く', async (_n, headers, via) => {
    const response = await buildPlainApp().request(
      '/managers/mgr-1/messages',
      call(headers, 'POST', messageBody),
    );
    expect(response.status).toBe(200);

    const [entry, ...rest] = await decisions();
    expect(rest).toEqual([]);
    expect(entry?.humanAction).toEqual({ kind: 'manager_message', target: 'mgr-1', via });
    expect(entry?.decision).toBe('人間が担当 mgr-1 へ直接送った（抜粋: 続けて）');
  });

  it('アカウント経路: via に accountId が写る', async () => {
    const app = buildAuthedApp();
    const { headers, accountId } = await grantedAccountToken(app);
    const response = await app.request(
      '/managers/mgr-1/messages',
      call(headers, 'POST', messageBody),
    );
    expect(response.status).toBe(200);

    expect(
      decisionWithGrounds(await decisions(), '人間が直接 API からマネージャーへ送った').humanAction,
    ).toEqual({
      kind: 'manager_message',
      target: 'mgr-1',
      via: { kind: 'account', accountId },
    });
  });

  it.each(['answered', 'held'] as const)('outcome=%s でも付く', async (outcome) => {
    sendResult = { outcome, detail: '効いた' };
    await buildPlainApp().request(
      '/managers/mgr-1/messages',
      call(OPERATOR, 'POST', { ...messageBody, requestId: 'req-1' }),
    );

    const [entry] = await decisions();
    expect(entry?.humanAction).toMatchObject({ kind: 'manager_message', target: 'mgr-1' });
    expect(entry?.decision).toContain('許可確認（req-1）');
  });

  it('長い本文は先頭 200 字で切り、切ったと分かる注記が付く（全文は書かない）', async () => {
    const long = 'あ'.repeat(500);
    await buildPlainApp().request(
      '/managers/mgr-1/messages',
      call(OPERATOR, 'POST', { text: long }),
    );

    const [entry] = await decisions();
    expect(entry?.decision).toContain('あ'.repeat(200) + '…');
    expect(entry?.decision).not.toContain('あ'.repeat(201));
    expect(entry?.decision).toContain('300 文字省略');
  });

  it.each(['session_missing', 'declined'] as const)(
    'outcome=%s（効かなかった回）には decision を積まない',
    async (outcome) => {
      sendResult = { outcome, detail: '届いていない' };
      const response = await buildPlainApp().request(
        '/managers/mgr-1/messages',
        call(OPERATOR, 'POST', messageBody),
      );
      expect(response.status).toBe(200);
      expect(sends).toHaveLength(1);
      expect(await decisions()).toEqual([]);
    },
  );
});

describe('連携の鍵（人間ではない）には付けない', () => {
  it('humanActionOf は integration の principal には印を作らず、投げもしない', () => {
    const integration = {
      kind: 'integration' as const,
      keyId: 'k1',
      name: 'ci',
      source: 'ci.main',
      limits: {} as never,
    };
    expect(humanActionOf(integration, 'commitment_close', 'c-1')).toEqual({});
  });

  it('humanActionOf は operator・account の principal へ via を写す', () => {
    expect(humanActionOf({ kind: 'operator', auth: 'disabled' }, 'schedule_remove', 'k')).toEqual({
      humanAction: {
        kind: 'schedule_remove',
        target: 'k',
        via: { kind: 'operator', auth: 'disabled' },
      },
    });
    expect(
      humanActionOf(
        { kind: 'account', account: { id: 'acc-9' } as AuthAccount },
        'practice_remove',
        'daily',
      ),
    ).toEqual({
      humanAction: {
        kind: 'practice_remove',
        target: 'daily',
        via: { kind: 'account', accountId: 'acc-9' },
      },
    });
  });

  it('連携の鍵でこの6つの口を叩いても門で 403 になり、decision は1行も積まれない', async () => {
    const app = buildAuthedApp();
    const created = (await (
      await app.request(
        '/integration-keys',
        call(OPERATOR, 'POST', { name: 'ci の鍵', source: 'ci.main' }),
      )
    ).json()) as { value: string };
    const headers = { authorization: `Bearer ${created.value}` };
    const before = (await decisions()).length;

    const statuses = await Promise.all([
      app.request('/commitments/c-1/close', call(headers, 'POST', { reason: 'x' })),
      app.request('/commitments/c-1/reopen', call(headers, 'POST', { reason: 'x' })),
      app.request('/schedule/issue-round', call(headers, 'DELETE')),
      app.request('/practices/daily', call(headers, 'DELETE')),
      app.request(
        '/practices/daily',
        call(headers, 'PUT', { kind: '日報', title: '題', content: '本文' }),
      ),
      app.request('/managers/mgr-1/messages', call(headers, 'POST', { text: 'x' })),
    ]).then((responses) => responses.map((response) => response.status));

    expect(statuses).toEqual([403, 403, 403, 403, 403, 403]);
    expect((await decisions()).length).toBe(before);
    expect(sends).toEqual([]);
  });
});

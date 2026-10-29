import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost, Stores, Task } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

function setup(stores: Stores = createMemoryStores()) {
  const clone: CloneHost = {
    postPersisted: async () => 'persisted',
    post: () => {},
    recycleSessionForToken: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval() {},
    async dropQueuedInboxEvents() {
      return 0;
    },
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
  const app = createApp({ clone, stores, token: 'test-token', shutdown: () => {} });
  const get = (path: string) =>
    app.request(path, { method: 'GET', headers: { authorization: 'Bearer test-token' } });
  return { stores, get, app };
}

const AT = '2026-10-01T00:00:00.000Z';
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  createdAt: AT,
  updatedAt: AT,
  status: 'queued',
  origin: 'self',
  title: id,
  body: `${id}の本文`,
  ...overrides,
});

describe('GET /tasks/migration-plan（台帳→task の移行の dry-run。書かない）', () => {
  it('計画と集計を返し、台帳・task・日誌は1行も変わらない。本文は載せない', async () => {
    const { stores, get } = setup();
    await stores.commitments.open({
      id: 'h2',
      at: '2026-10-02T00:00:00.000Z',
      origin: 'human',
      body: '二つ目\n秘密の本文',
    });
    await stores.commitments.open({
      id: 'h1',
      at: '2026-10-01T00:00:00.000Z',
      origin: 'human',
      body: '一つ目\n詳細',
    });
    await stores.commitments.open({
      id: 'm1',
      at: '2026-10-01T01:00:00.000Z',
      origin: 'manager',
      body: 'マネージャーの本文',
    });
    await stores.commitments.open({
      id: 'hc',
      at: '2026-09-01T00:00:00.000Z',
      origin: 'human',
      body: '済み',
    });
    await stores.commitments.close('hc', '2026-09-02T00:00:00.000Z', '済んだ', 'human');
    const before = JSON.stringify({
      c: await stores.commitments.list({ includeClosed: true }),
      t: await stores.tasks.list({ includeClosed: true }),
      j: await stores.journal.list(),
    });

    const response = await get('/tasks/migration-plan');
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as {
      dryRun: boolean;
      summary: { toTask: number; retire: number; skipClosed: number; oldestAt: string };
      items: { id: string; action: string; title?: string }[];
    };
    expect(body.dryRun).toBe(true);
    expect(body.items.map((item) => `${item.action}:${item.id}`)).toEqual([
      'skip-closed:hc',
      'task:h1',
      'retire:m1',
      'task:h2',
    ]);
    expect(body.items[1]?.title).toBe('一つ目');
    expect(body.summary).toMatchObject({
      toTask: 2,
      retire: 1,
      skipClosed: 1,
      oldestAt: '2026-10-01T00:00:00.000Z',
    });
    expect(text).not.toContain('秘密の本文');
    expect(text).not.toContain('execution');

    const after = JSON.stringify({
      c: await stores.commitments.list({ includeClosed: true }),
      t: await stores.tasks.list({ includeClosed: true }),
      j: await stores.journal.list(),
    });
    expect(after).toBe(before);
  });
});

describe('POST /tasks/migrate（台帳→task の移行の実行。dry-run の指紋が必須）', () => {
  async function seed(stores: ReturnType<typeof setup>['stores']) {
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '発言',
      conversationId: 'conv-1',
    });
    await stores.commitments.open({
      id: 'h1',
      at: '2026-10-01T00:00:00.000Z',
      origin: 'human',
      source: 'conv-1',
      body: '一つ目\n秘密の本文',
    });
    await stores.commitments.open({
      id: 'm1',
      at: '2026-10-01T01:00:00.000Z',
      origin: 'manager',
      body: 'マネージャーの本文',
    });
  }
  const post = (app: ReturnType<typeof setup>['app'], body: unknown, auth = 'Bearer test-token') =>
    app.request('/tasks/migrate', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const fingerprintOfPlan = async (get: ReturnType<typeof setup>['get']) =>
    ((await (await get('/tasks/migration-plan')).json()) as { fingerprint: string }).fingerprint;

  it('dry-run の指紋で実行でき、task が起点の会話つきで入り、台帳が閉じる。本文は応答に載らない', async () => {
    const { stores, get, app } = setup();
    await seed(stores);
    const fingerprint = await fingerprintOfPlan(get);

    const response = await post(app, { fingerprint });
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as {
      dryRun: boolean;
      fingerprint: string;
      execution: {
        migrated: number;
        retired: number;
        failed: unknown[];
        originConversation: { fromConversation: number; unresolvedIds: string[] };
      };
    };
    expect(body.dryRun).toBe(false);
    expect(body.fingerprint).toBe(fingerprint);
    expect(body.execution).toMatchObject({ migrated: 1, retired: 1, failed: [] });
    expect(body.execution.originConversation).toMatchObject({
      fromConversation: 1,
      unresolvedIds: [],
    });
    expect(text).not.toContain('秘密の本文');
    expect((await stores.tasks.get('h1'))?.originConversationId).toBe('conv-1');
    expect((await stores.commitments.list()).entries).toEqual([]);
  });

  it('指紋が違えば 409 で、台帳・task・日誌は1行も変わらない（dry-run のあとに台帳が動いた）', async () => {
    const { stores, get, app } = setup();
    await seed(stores);
    const stale = await fingerprintOfPlan(get);
    await stores.commitments.open({
      id: 'h2',
      at: '2026-10-02T00:00:00.000Z',
      origin: 'human',
      body: 'dry-run のあとに増えた依頼',
    });
    const snapshot = async () =>
      JSON.stringify({
        c: await stores.commitments.list({ includeClosed: true }),
        t: await stores.tasks.list({ includeClosed: true }),
        j: await stores.journal.list(),
      });
    const before = await snapshot();

    const response = await post(app, { fingerprint: stale });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('dry-run');
    expect(await snapshot()).toBe(before);

    // 取り直した指紋なら通る
    const fresh = await post(app, { fingerprint: await fingerprintOfPlan(get) });
    expect(fresh.status).toBe(200);
  });

  it('指紋が無い・空・JSON でない本文は 400（何も書かない）', async () => {
    const { stores, app } = setup();
    await seed(stores);
    for (const body of [{}, { fingerprint: '' }, { fingerprint: 1 }, 'not json']) {
      expect((await post(app, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await stores.commitments.list()).entries).toHaveLength(2);
    expect((await stores.tasks.list()).entries).toEqual([]);
  });

  it('起点の会話を引く読みが失敗したら、dry-run も実行も 500 で何も書かない', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    await stores.commitments.open({
      id: 'h2',
      at: '2026-10-02T00:00:00.000Z',
      origin: 'human',
      source: 'apr-bad',
      body: '承認から',
    });
    const jobs = new Proxy(stores.jobs, {
      get(target, prop) {
        if (prop === 'getApproval') return () => Promise.reject(new Error('jobs down'));
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const { app, get } = setup({ ...stores, jobs });
    const plan = await get('/tasks/migration-plan');
    expect(plan.status).toBe(500);
    const run = await post(app, { fingerprint: 'x' });
    expect(run.status).toBe(500);
    expect((await stores.tasks.list()).entries).toEqual([]);
    expect((await stores.commitments.list()).entries).toHaveLength(3);
  });
});

describe('GET /tasks（読むだけの口）', () => {
  it('開いている行を並び順で返し、閉じた行は includeClosed=true のときだけ後ろに足す', async () => {
    const { stores, get } = setup();
    await stores.tasks.add(task('a'));
    await stores.tasks.add(task('b'), { kind: 'front' });
    await stores.tasks.add(task('c'));
    await stores.tasks.setStatus('c', 'done', { reason: '済んだ', by: 'human', at: AT });

    const open = await get('/tasks');
    expect(open.status).toBe(200);
    const openBody = (await open.json()) as { entries: Task[]; unreadable: unknown[] };
    expect(openBody.entries.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(openBody.unreadable).toEqual([]);

    const all = await get('/tasks?includeClosed=true');
    const allBody = (await all.json()) as { entries: Task[] };
    expect(allBody.entries.map((entry) => entry.id)).toEqual(['b', 'a', 'c']);
    expect(allBody.entries[2]?.closedReason).toBe('済んだ');
  });

  it('本文を切らずに返す', async () => {
    const { stores, get } = setup();
    const long = 'あ'.repeat(5_000);
    await stores.tasks.add(task('a', { body: long }));
    const body = (await (await get('/tasks')).json()) as { entries: Task[] };
    expect(body.entries[0]?.body).toBe(long);
  });

  it('includeClosed の不正な値は 400', async () => {
    const { get } = setup();
    expect((await get('/tasks?includeClosed=yes')).status).toBe(400);
  });

  it('書く口は HTTP に無い（P2 は読むだけ）。移行の計画の口にも書く動詞は無い', async () => {
    const { app } = setup();
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const response = await app.request('/tasks/migration-plan', {
        method,
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status, method).toBe(404);
    }
  });

  it('書く口は HTTP に無い（P2 は読むだけ）', async () => {
    const { app } = setup();
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const response = await app.request('/tasks', {
        method,
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status, method).toBe(404);
    }
  });
});

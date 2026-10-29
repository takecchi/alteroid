import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost, Task } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

function setup() {
  const stores = createMemoryStores();
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

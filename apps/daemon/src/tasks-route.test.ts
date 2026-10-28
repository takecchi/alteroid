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

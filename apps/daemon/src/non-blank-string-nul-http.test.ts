import { createMemoryStores, createTokenPoolService } from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

function stubCloneHost(): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: {} as CloneHost['managers'],
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

const send = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const NUL_ONLY = ['\u0000', '\u0000\u0000', ' \u0000 ', '\u0000\n'];

describe('NUL だけの理由・ラベルを HTTP の入口が断る（nonBlankString）', () => {
  let stores: Stores;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stores = createMemoryStores();
    app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores }),
    });
  });

  function expectNoEcho(text: string): void {
    expect(text).not.toContain('\u0000');
    expect(text).not.toContain('u0000');
    expect(text).not.toContain('fake-secret');
  }

  async function addTask(): Promise<void> {
    await stores.tasks.add({
      id: 't1',
      createdAt: '2026-10-06T00:00:00.000Z',
      updatedAt: '2026-10-06T00:00:00.000Z',
      status: 'queued',
      origin: 'self',
      title: '題',
      body: '本文',
    });
  }

  // 台帳の `POST /commitments/:id/close` は外れた（段2b）。同じ判定を task の閉じる口が持つ。
  it.each(NUL_ONLY)('POST /tasks/:id/close の reason %j は 400 で、閉じない', async (r) => {
    await addTask();
    const res = await app.request('/tasks/t1/close', send('POST', { status: 'done', reason: r }));
    expect(res.status).toBe(400);
    expectNoEcho(await res.text());
    const row = (await stores.tasks.list({ includeClosed: true })).entries[0];
    expect(row?.status).toBe('queued');
    expect(row?.closedReason).toBeUndefined();
  });

  it('POST /tasks/:id/close の reason は NUL が混じっても中身が残れば通る', async () => {
    await addTask();
    const res = await app.request(
      '/tasks/t1/close',
      send('POST', { status: 'done', reason: 'a\u0000b' }),
    );
    expect(res.status).toBe(200);
    expect((await stores.tasks.list({ includeClosed: true })).entries[0]?.closedReason).toBe('ab');
  });

  it.each(NUL_ONLY)('PUT /tokens の label %j は 400 で、保存しない', async (label) => {
    const res = await app.request(
      '/tokens',
      send('PUT', { tokens: [{ label, value: 'fake-secret' }] }),
    );
    expect(res.status).toBe(400);
    expectNoEcho(await res.text());
    const list = (await (await app.request('/tokens')).json()) as { tokens: unknown[] };
    expect(list.tokens).toEqual([]);
  });

  it('PUT /tokens の label は NUL が混じっても中身が残れば通る', async () => {
    const res = await app.request(
      '/tokens',
      send('PUT', { tokens: [{ label: 'my\u0000label', value: 'fake-secret' }] }),
    );
    expect(res.status).toBe(200);
  });

  it.each(NUL_ONLY)('POST /inbox/remove の reason %j は 400', async (reason) => {
    const res = await app.request(
      '/inbox/remove',
      send('POST', { types: ['manager_message'], reason, dryRun: false }),
    );
    expect(res.status).toBe(400);
    expectNoEcho(await res.text());
  });

  it('POST /inbox/remove の reason は NUL が混じっても中身が残れば通る', async () => {
    const res = await app.request(
      '/inbox/remove',
      send('POST', { types: ['manager_message'], reason: 'a\u0000b', dryRun: true }),
    );
    expect(res.status).toBe(200);
  });
});

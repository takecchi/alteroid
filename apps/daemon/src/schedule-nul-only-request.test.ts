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

const send = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const spec = { type: 'every', minutes: 5 } as const;

describe('POST /schedule の request が NUL だけのとき（#3438）', () => {
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

  it('400 で断る（500 にしない）', async () => {
    const res = await app.request('/schedule', send({ kind: 'k1', request: '\u0000', spec }));
    expect(res.status).toBe(400);
  });

  it('日誌に「設定しようとしている」を積まず、何も保存しない', async () => {
    await app.request('/schedule', send({ kind: 'k1', request: '\u0000\u0000', spec }));
    expect(await stores.journal.list({})).toEqual([]);
    expect(await stores.schedules.get('k1')).toBeNull();
  });

  it('400 の文に送られた値を載せない', async () => {
    const res = await app.request('/schedule', send({ kind: 'k1', request: '\u0000', spec }));
    const raw = await res.text();
    expect(raw).not.toContain('\u0000');
    expect(raw).not.toContain('\\u0000');
  });

  it('従来どおり空文字も 400', async () => {
    const res = await app.request('/schedule', send({ kind: 'k1', request: '', spec }));
    expect(res.status).toBe(400);
  });

  it('NUL が混じっても中身が残る request は受け、NUL を落として保存する', async () => {
    const res = await app.request(
      '/schedule',
      send({ kind: 'k1', request: '定期\u0000的に確認する', spec }),
    );
    expect(res.status).toBe(200);
    expect((await stores.schedules.get('k1'))?.request).toBe('定期的に確認する');
  });
});

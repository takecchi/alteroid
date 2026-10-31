import { createMemoryStores } from '@alteroid/core';
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

// 台帳の `POST /commitments` は外れた（段2b）。同じ判定を人間が仕事を積む口（`POST /tasks`）が持つ。
describe('仕事の source が NUL だけなら空として残さない（HTTP の入口）', () => {
  let stores: Stores;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stores = createMemoryStores();
    app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
  });

  it('POST /tasks の source が NUL だけなら 400 で、行を作らない', async () => {
    const empty = await app.request(
      '/tasks',
      send('POST', { title: '題', body: '本文', source: '' }),
    );
    const nul = await app.request(
      '/tasks',
      send('POST', { title: '題', body: '本文', source: '\u0000' }),
    );
    expect(empty.status).toBe(400);
    expect(nul.status, `空文字は 400 なのに NUL だけは ${nul.status}`).toBe(400);
    expect((await stores.tasks.list()).entries).toEqual([]);
  });

  it('POST /tasks の source が実のある文字列なら積む', async () => {
    const res = await app.request(
      '/tasks',
      send('POST', { title: '題', body: '本文', source: 'issue-1' }),
    );
    expect(res.status).toBe(200);
    expect((await stores.tasks.list()).entries.map((e) => e.source)).toEqual(['issue-1']);
  });
});

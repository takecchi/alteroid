import type { CloneHost } from '@alteroid/core';
import { createPgStoresFromDb, type Db, type PgStores } from '@alteroid/storage-pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

// 雛形は前払いする: 最初の `beforeEach`（hookTimeout 10s）で WASM の起動 + migrate を払わせないため。
beforeAll(async () => {
  await migratedTemplate();
}, 60_000);

let db: Db;
let stores: PgStores;
let app: ReturnType<typeof createApp>;

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

const badSlug = 'Not_Valid_SLUG!';

beforeEach(async () => {
  ({ db } = await createMigratedPglite());
  stores = createPgStoresFromDb(db);
  app = createApp({
    clone: stubCloneHost(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
});

describe('GET /practices/:slug/versions* は不正なスラッグを 400 で断る（pg 実装。issue #1670）', () => {
  it('GET /practices/:slug/versions — 直す前は pg で 500 だった', async () => {
    const res = await app.request(`/practices/${badSlug}/versions`);
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    expect(res.status, `本文: ${JSON.stringify(body)}`).toBe(400);
    expect(body).toEqual({ error: 'やり方のスラッグが不正' });
  });

  it('GET /practices/:slug/versions/:version — 直す前は pg で 500 だった', async () => {
    const res = await app.request(`/practices/${badSlug}/versions/1`);
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    expect(res.status, `本文: ${JSON.stringify(body)}`).toBe(400);
    expect(body).toEqual({ error: 'やり方のスラッグが不正' });
  });

  it('比較対象: 形式が正しい slug は今までどおり通る（pg 実装）', async () => {
    await stores.practices.write({
      slug: 'investigate-1670',
      kind: '調査',
      title: '題',
      content: '本文',
    });

    const list = await app.request('/practices/investigate-1670/versions');
    expect(list.status).toBe(200);

    const read = await app.request('/practices/investigate-1670/versions/1');
    expect(read.status).toBe(200);
  });
});

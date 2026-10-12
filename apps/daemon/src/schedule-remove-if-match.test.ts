import { createMemoryStores } from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb } from '@alteroid/storage-pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

beforeAll(async () => {
  await migratedTemplate();
}, 60_000);

const spec = { type: 'daily', at: '09:00' } as const;
const KIND = 'morning';
const SEEN = '2026-10-01T00:00:00.000Z';

async function fsStores(): Promise<Stores> {
  return createFsStores(await makeTempDir('alteroid-test-'));
}

async function pgStores(): Promise<Stores> {
  const { db } = await createMigratedPglite();
  return createPgStoresFromDb(db);
}

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

function remove(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request(`/schedule/${KIND}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe.each([
  ['memory', async () => createMemoryStores()],
  ['fs', fsStores],
  ['pg', pgStores],
] as const)('DELETE /schedule/:kind の ifMatch（%s 実装。#4599）', (_label, make) => {
  let stores: Stores;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    stores = await make();
    app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
    await stores.schedules.put({
      kind: KIND,
      spec,
      request: '人間が見た本文',
      createdAt: SEEN,
      updatedAt: SEEN,
    });
  });

  it('見た後にほかで書き換えられていれば、見た版での削除は 409 で外さない（いまの依頼を返す）', async () => {
    // 見た後に、クローン（または別のタブ）が書き換える
    await stores.schedules.editRequest(
      KIND,
      { request: 'クローンが直した本文', spec },
      '2026-10-02T00:00:00.000Z',
    );

    const response = await remove(app, { ifMatch: SEEN });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { current: { request: string } | null };
    expect(body.current?.request).toBe('クローンが直した本文');
    expect((await stores.schedules.get(KIND))?.request).toBe('クローンが直した本文');
  });

  it('版が合えば外す', async () => {
    const response = await remove(app, { ifMatch: SEEN });

    expect(response.status).toBe(200);
    expect(await stores.schedules.get(KIND)).toBeNull();
  });

  it('対照: 本文が {} なら、今までどおり比べずに外す', async () => {
    await stores.schedules.editRequest(
      KIND,
      { request: 'クローンが直した本文', spec },
      '2026-10-02T00:00:00.000Z',
    );

    const response = await remove(app, {});

    expect(response.status).toBe(200);
    expect(await stores.schedules.get(KIND)).toBeNull();
  });

  it('対照: 本文を付けない呼び手（CLI の /unschedule）も、今までどおり外せる', async () => {
    const response = await app.request(`/schedule/${KIND}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.status).toBe(200);
    expect(await stores.schedules.get(KIND)).toBeNull();
  });
});

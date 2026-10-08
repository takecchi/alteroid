import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost, PendingApproval, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, type Db } from '@alteroid/storage-pg';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

const T = (n: number): string => new Date(Date.UTC(2026, 2, 1, 0, 0, n)).toISOString();

function approval(id: string, n: number, extra: Partial<PendingApproval> = {}): PendingApproval {
  return { id, createdAt: T(n), question: `q-${id}`, ...extra };
}

function fakeCloneHost(stores: Stores): CloneHost {
  return {
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
}

async function defaultIds(stores: Stores, query: string): Promise<string[]> {
  const response = await createApp({
    clone: fakeCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => {},
  }).request(`/approvals${query}`, { headers: { authorization: 'Bearer test-token' } });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { approvals: { id: string }[]; total?: number };
  expect('total' in body).toBe(false);
  return body.approvals.map((a) => a.id);
}

// 回答で書き直した行（ストアによっては末尾へ動く）と、同じ `createdAt` の2件（id の逆順に入れる）。
async function seed(stores: Stores): Promise<void> {
  await stores.jobs.putApproval(approval('a1', 1));
  await stores.jobs.putApproval(approval('b1', 2));
  await stores.jobs.putApproval(approval('z9', 3));
  await stores.jobs.putApproval(approval('y9', 3));
  await stores.jobs.putApproval(approval('a1', 1, { answeredAt: T(40), answer: 'はい' }));
}

async function expectCreatedOrder(stores: Stores): Promise<void> {
  expect(await defaultIds(stores, '?pending=false')).toEqual(['a1', 'b1', 'y9', 'z9']);
  expect(await defaultIds(stores, '')).toEqual(['b1', 'y9', 'z9']);
}

beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

describe('GET /approvals の既定の呼びも (createdAt, id) の昇順で返す（#4090）', () => {
  it('インメモリ', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    await expectCreatedOrder(stores);
  });

  it('fs', async () => {
    const stores = createFsStores(await makeTempDir('alteroid-test-'));
    await seed(stores);
    await expectCreatedOrder(stores);
  });

  describe('pg（PGlite）', () => {
    let client: PGlite;
    afterEach(async () => {
      await client.close();
    });

    it('同じ並び', async () => {
      let db: Db;
      ({ client, db } = await createMigratedPglite());
      const stores = createPgStoresFromDb(db);
      await seed(stores);
      await expectCreatedOrder(stores);
    });
  });
});

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
} from '@alteroid/core';
import type { CloneHost, PendingApproval, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables, type Db } from '@alteroid/storage-pg';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

const T = (n: number): string => new Date(Date.UTC(2026, 2, 1, 0, 0, n)).toISOString();

function approval(
  id: string,
  n: number,
  conversationId: string | undefined,
  extra: Partial<PendingApproval> = {},
): PendingApproval {
  return {
    id,
    createdAt: T(n),
    question: `q-${id}`,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...extra,
  };
}

const GOOD: PendingApproval[] = [
  approval('a1', 1, 'conv-a'),
  approval('b1', 2, 'conv-b'),
  approval('a2', 3, 'conv-a', { answeredAt: T(30), answer: 'はい' }),
  approval('none1', 4, undefined),
  approval('a3', 5, 'conv-a'),
  approval('a4', 6, 'conv-a'),
];

const BAD_RAW = { id: 'ap-bad', createdAt: 'not-a-date', question: 'x', conversationId: 'conv-a' };
const BAD_OTHER_CONV = { ...BAD_RAW, id: 'ap-bad-other', conversationId: 'conv-b' };
const BAD_NO_CONV = { id: 'ap-bad-noconv', createdAt: 'not-a-date', question: 'x' };
const BAD_NUM_CONV = { ...BAD_RAW, id: 'ap-bad-num', conversationId: 5 };
const BAD_ROWS = [BAD_RAW, BAD_OTHER_CONV, BAD_NO_CONV, BAD_NUM_CONV];

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

type Body = {
  approvals: { id: string }[];
  total?: number;
  nextCursor?: string;
  unreadable?: { id?: string }[];
};

function appOver(stores: Stores) {
  return createApp({
    clone: fakeCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => {},
  });
}

async function get(stores: Stores, query: string): Promise<Body> {
  const response = await appOver(stores).request(`/approvals${query}`, {
    headers: { authorization: 'Bearer test-token' },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Body;
}

const ids = (body: Body): string[] => body.approvals.map((a) => a.id);

async function expectSameResponses(stores: Stores, withBad: boolean): Promise<void> {
  const check = (body: Body, ...bad: string[]): void => {
    expect(body.unreadable?.map((u) => u.id)).toEqual(withBad && bad.length > 0 ? bad : undefined);
  };

  const dflt = await get(stores, '?conversationId=conv-a');
  expect(ids(dflt)).toEqual(['a1', 'a3', 'a4']);
  expect('total' in dflt).toBe(false);
  expect('nextCursor' in dflt).toBe(false);
  check(dflt, 'ap-bad');

  const all = await get(stores, '?conversationId=conv-a&pending=false&order=asc');
  expect(ids(all)).toEqual(['a1', 'a2', 'a3', 'a4']);
  expect(all.total).toBe(4);
  expect('nextCursor' in all).toBe(false);
  check(all, 'ap-bad');

  const d1 = await get(stores, '?conversationId=conv-a&pending=false&order=desc&limit=3');
  expect(ids(d1)).toEqual(['a4', 'a3', 'a2']);
  expect(d1.total).toBe(4);
  expect(d1.nextCursor).toBeDefined();
  check(d1, 'ap-bad');
  const d2 = await get(
    stores,
    `?conversationId=conv-a&pending=false&order=desc&limit=3&cursor=${encodeURIComponent(d1.nextCursor ?? '')}`,
  );
  expect(ids(d2)).toEqual(['a1']);
  expect(d2.total).toBe(4);
  expect('nextCursor' in d2).toBe(false);
  check(d2, 'ap-bad');

  const p1 = await get(stores, '?conversationId=conv-a&order=asc&limit=2');
  expect(ids(p1)).toEqual(['a1', 'a3']);
  expect(p1.total).toBe(3);
  expect(p1.nextCursor).toBeDefined();
  const p2 = await get(
    stores,
    `?conversationId=conv-a&order=asc&limit=2&cursor=${encodeURIComponent(p1.nextCursor ?? '')}`,
  );
  expect(ids(p2)).toEqual(['a4']);
  expect(p2.total).toBe(3);
  expect('nextCursor' in p2).toBe(false);

  const b = await get(stores, '?conversationId=conv-b&order=asc');
  expect(ids(b)).toEqual(['b1']);
  expect(b.total).toBe(1);
  check(b, 'ap-bad-other');
  const none = await get(stores, '?conversationId=conv-nothing&order=asc&limit=5');
  expect(ids(none)).toEqual([]);
  expect(none.total).toBe(0);
  check(none);

  const unfiltered = await get(stores, '?pending=false&order=asc');
  expect(ids(unfiltered)).toEqual(['a1', 'b1', 'a2', 'none1', 'a3', 'a4']);
  expect(unfiltered.total).toBe(6);
  expect(unfiltered.unreadable?.map((u) => u.id).sort()).toEqual(
    withBad ? ['ap-bad', 'ap-bad-noconv', 'ap-bad-num', 'ap-bad-other'] : undefined,
  );
}

beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

describe('GET /approvals の conversationId — ストアの側の絞り（#3290）', () => {
  it('インメモリ', async () => {
    const stores = createMemoryStores();
    for (const a of GOOD) await stores.jobs.putApproval(a);
    await expectSameResponses(stores, false);
  });

  it('fs（読めない行つき）', async () => {
    const root = await makeTempDir('alteroid-test-');
    const dir = join(root, 'jobs');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'jobs.json'),
      `${JSON.stringify({ jobs: [], approvals: [...BAD_ROWS, ...GOOD] }, null, 2)}\n`,
    );
    await captureStderr(async () => {
      await expectSameResponses(createFsStores(root), true);
    });
  });

  describe('pg（PGlite。読めない行つき）', () => {
    let client: PGlite;
    afterEach(async () => {
      await client.close();
    });

    it('同じ応答', async () => {
      let db: Db;
      ({ client, db } = await createMigratedPglite());
      const stores = createPgStoresFromDb(db);
      for (const a of GOOD) await stores.jobs.putApproval(a);
      for (const raw of BAD_ROWS) {
        await db.insert(tables.approvals).values({
          id: raw.id,
          createdAt: new Date(T(0)),
          answeredAt: null,
          withdrawnAt: null,
          approval: raw,
        });
      }
      await captureStderr(async () => {
        await expectSameResponses(stores, true);
      });
    });
  });

  it('会話の絞りはストアへ渡り、サーバは全件を取って絞らない', async () => {
    const stores = createMemoryStores();
    for (const a of GOOD) await stores.jobs.putApproval(a);
    const spy = vi.spyOn(stores.jobs, 'listApprovals');
    await get(stores, '?conversationId=conv-a&pending=false&order=asc');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ pendingOnly: false, conversationId: 'conv-a' });
    spy.mockClear();
    await get(stores, '?pending=false');
    expect(spy).toHaveBeenCalledWith({ pendingOnly: false });
  });

  it('ストアが返した集合をそのまま使う（サーバ側でもう一度絞らない）', async () => {
    const stores = createMemoryStores();
    for (const a of GOOD) await stores.jobs.putApproval(a);
    vi.spyOn(stores.jobs, 'listApprovals').mockResolvedValue({
      entries: [GOOD[1] as PendingApproval],
      unreadable: [],
    });
    const body = await get(stores, '?conversationId=conv-a&order=asc');
    expect(ids(body)).toEqual(['b1']);
    expect(body.total).toBe(1);
  });
});

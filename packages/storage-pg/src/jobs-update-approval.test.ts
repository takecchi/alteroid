import type { PendingApproval } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb } from './test-db.test-support.js';

let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

const APPROVAL: PendingApproval = {
  id: 'ap-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  question: '本番に出してよいか',
};

describe('PgJobStore.updateApproval（issue #2007）', () => {
  it('行が無ければ null を返し、mutate を呼ばない', async () => {
    let called = false;
    const result = await stores.jobs.updateApproval('nope', (current) => {
      called = true;
      return current;
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it('mutate の結果を書いて返し、回答済みの行は pendingOnly の一覧から外れる', async () => {
    await stores.jobs.putApproval(APPROVAL);
    const result = await stores.jobs.updateApproval('ap-1', (current) => ({
      ...current,
      answeredAt: '2026-09-01T00:05:00.000Z',
      answer: 'よい',
    }));
    expect(result?.answer).toBe('よい');
    expect((await stores.jobs.getApproval('ap-1'))?.answer).toBe('よい');
    expect((await stores.jobs.listApprovals({ pendingOnly: true })).entries).toEqual([]);
  });

  it('mutate が null を返したら何も書かず null を返す', async () => {
    await stores.jobs.putApproval(APPROVAL);
    const result = await stores.jobs.updateApproval('ap-1', () => null);
    expect(result).toBeNull();
    expect(await stores.jobs.getApproval('ap-1')).toEqual(APPROVAL);
  });
});

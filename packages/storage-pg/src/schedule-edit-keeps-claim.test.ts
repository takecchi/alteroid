import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * Issue #1654。fs 版（`packages/storage-fs/src/schedule-edit-keeps-claim
 * .test.ts`）と同じ歯を pg 実装（`PgScheduleStore`）に当てる——`ScheduleStore`
 * は「能力の差を作らない」別の器（`schedules.ts` 冒頭の doc）なので、両方が
 * 同じ形で直っていることを確かめる。
 */
describe('ScheduleStore.editRequest() — claimRun 済みの印を消さない（pg 実装）', () => {
  let client: PGlite;
  let db: Db;
  let stores: PgStores;

  const plan = {
    kind: 'issue-round',
    spec: { type: 'daily' as const, at: '09:00' },
    request: 'open issue を見て実装を進める',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  };

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client);
    await migrate(db);
    stores = createPgStoresFromDb(db);
  });

  afterEach(async () => {
    await client.close();
  });

  it('claimRun の後に editRequest で本文だけ直しても、pendingRun / lastRunAt は残る', async () => {
    await stores.schedules.put(plan);

    const claimed = await stores.schedules.claimRun(
      'issue-round',
      plan.updatedAt,
      '2026-08-13T00:00:00.000Z',
      'schedule',
    );
    expect(claimed).not.toBeNull();

    const edited = await stores.schedules.editRequest(
      'issue-round',
      { request: '人間が本文だけ直した', spec: { type: 'daily', at: '10:00' } },
      '2026-08-13T00:00:05.000Z',
    );

    expect(edited).toMatchObject({
      kind: 'issue-round',
      request: '人間が本文だけ直した',
      spec: { type: 'daily', at: '10:00' },
      createdAt: plan.createdAt,
      updatedAt: '2026-08-13T00:00:05.000Z',
      lastRunAt: '2026-08-13T00:00:00.000Z',
      pendingRun: { at: '2026-08-13T00:00:00.000Z', cause: 'schedule' },
    });

    const stored = await stores.schedules.get('issue-round');
    expect(stored).toEqual(edited);
  });

  it('その後の completeRun も空振りしない——lastScheduledRunAt が実際に進む', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.claimRun(
      'issue-round',
      plan.updatedAt,
      '2026-08-13T00:00:00.000Z',
      'schedule',
    );
    await stores.schedules.editRequest(
      'issue-round',
      { request: '本文だけ直した', spec: plan.spec },
      '2026-08-13T00:00:05.000Z',
    );

    await stores.schedules.completeRun('issue-round', '2026-08-13T00:00:00.000Z', 'schedule');

    const after = await stores.schedules.get('issue-round');
    expect(after?.pendingRun).toBeUndefined();
    expect(after?.lastScheduledRunAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('無い kind への editRequest は null（呼び出し側が put() で新規に作る側へ倒れる）', async () => {
    expect(
      await stores.schedules.editRequest(
        'no-such-kind',
        { request: 'x', spec: { type: 'daily', at: '09:00' } },
        '2026-08-13T00:00:00.000Z',
      ),
    ).toBeNull();
    expect(await stores.schedules.list()).toEqual([]);
  });

  it('空文字の request は拒む（put() と同じく scheduledRequestSchema を通す）', async () => {
    await stores.schedules.put(plan);
    await expect(
      stores.schedules.editRequest(
        'issue-round',
        { request: '', spec: plan.spec },
        '2026-08-13T00:00:00.000Z',
      ),
    ).rejects.toThrow();
  });
});

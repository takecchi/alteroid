import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

/**
 * Issue #1654。fs / pg と同じ歯をインメモリ実装にも当てる（#1652 と同じ並び
 * ——`packages/storage-fs/src/schedule-edit-keeps-claim.test.ts` /
 * `packages/storage-pg/src/schedule-edit-keeps-claim.test.ts` を見よ）。
 */
describe('ScheduleStore.editRequest() — claimRun 済みの印を消さない（インメモリ実装）', () => {
  const plan = {
    kind: 'issue-round',
    spec: { type: 'daily' as const, at: '09:00' },
    request: 'open issue を見て実装を進める',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  };

  it('claimRun の後に editRequest で本文だけ直しても、pendingRun / lastRunAt は残る', async () => {
    const stores = createMemoryStores();
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
      request: '人間が本文だけ直した',
      spec: { type: 'daily', at: '10:00' },
      lastRunAt: '2026-08-13T00:00:00.000Z',
      pendingRun: { at: '2026-08-13T00:00:00.000Z', cause: 'schedule' },
    });
  });

  it('その後の completeRun も空振りしない——lastScheduledRunAt が実際に進む', async () => {
    const stores = createMemoryStores();
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

  it('無い kind への editRequest は null', async () => {
    const stores = createMemoryStores();
    expect(
      await stores.schedules.editRequest(
        'no-such-kind',
        { request: 'x', spec: { type: 'daily', at: '09:00' } },
        '2026-08-13T00:00:00.000Z',
      ),
    ).toBeNull();
  });

  it('空文字の request は拒む（put() と同じく scheduledRequestSchema を通す。issue #1652 と同じ規律）', async () => {
    const stores = createMemoryStores();
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

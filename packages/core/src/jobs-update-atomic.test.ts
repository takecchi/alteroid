import { describe, expect, it } from 'vitest';

import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * Issue #1674。fs / pg と同じ歯をインメモリ実装にも当てる（#1652 と同じ並び
 * ——`packages/storage-fs/src/jobs-update-atomic.test.ts` /
 * `packages/storage-pg/src/jobs-update-atomic.test.ts` を見よ）。
 */
describe('JobStore.updateJob()（インメモリ実装）', () => {
  const job: Job = {
    id: 'mgr-lost',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'lost',
    summary: '調べ物',
    sessionId: 'sess-old',
    runnerId: 'runner-primary',
  };

  it('現在値を読み直す——外から先に割り込んだ書き込みは消えない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);

    await stores.jobs.putJob({
      ...job,
      status: 'running',
      sessionId: 'sess-new',
      updatedAt: '2026-09-01T00:05:00.000Z',
    });

    const updated = await stores.jobs.updateJob(job.id, (current) => ({
      ...current,
      appraisal: 'good',
      appraisedAt: '2026-09-01T00:10:00.000Z',
      appraisedBy: 'human',
    }));

    expect(updated).toMatchObject({
      status: 'running',
      sessionId: 'sess-new',
      appraisal: 'good',
      appraisedBy: 'human',
    });

    const stored = await stores.jobs.listJobs().then((all) => all.find((j) => j.id === job.id));
    expect(stored).toEqual(updated);
  });

  it('無い id は null——mutate は呼ばれない', async () => {
    const stores = createMemoryStores();
    let called = false;
    const result = await stores.jobs.updateJob('no-such-job', (current) => {
      called = true;
      return current;
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it('同じ id に2本 updateJob が来ても、互いの変更を消さない（同期アクセスなので隙間が無い）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);

    const [a, b] = await Promise.all([
      stores.jobs.updateJob(job.id, (current) => ({
        ...current,
        appraisal: 'good',
        appraisedBy: 'clone',
      })),
      stores.jobs.updateJob(job.id, (current) => ({
        ...current,
        lastReport: '2本目の書き込み',
      })),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const stored = await stores.jobs.listJobs().then((all) => all.find((j) => j.id === job.id));
    expect(stored?.appraisal).toBe('good');
    expect(stored?.appraisedBy).toBe('clone');
    expect(stored?.lastReport).toBe('2本目の書き込み');
  });

  it('本物（fs / pg）と同じく jobSchema を通す（issue #1652 と同じ規律）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    await expect(
      stores.jobs.updateJob(job.id, (current) => ({
        ...current,
        // `status` に台帳の6値以外を渡す——jobSchema がここを拒む。
        status: 'not-a-real-status' as unknown as Job['status'],
      })),
    ).rejects.toThrow();
  });
});

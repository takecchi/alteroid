import { beforeEach, describe, expect, it } from 'vitest';

import type { Job } from '@alteroid/core';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('JobStore.updateJob()（fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

  const job: Job = {
    id: 'mgr-lost',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'lost',
    summary: '調べ物',
    sessionId: 'sess-old',
    runnerId: 'runner-primary',
  };

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

  it('現在値を排他区間の中で読み直す——外から先に割り込んだ書き込みは消えない', async () => {
    await stores.jobs.putJob(job);

    await stores.jobs.putJob({
      ...job,
      status: 'running',
      sessionId: 'sess-new',
      updatedAt: '2026-09-01T00:05:00.000Z',
    });

    const updated = await stores.jobs.updateJob(job.id, (current) => ({
      ...current,
      lastReport: '外から先に割り込んだ報告',
    }));

    expect(updated).toMatchObject({
      status: 'running',
      sessionId: 'sess-new',
      lastReport: '外から先に割り込んだ報告',
    });

    const stored = await stores.jobs.listJobs().then((all) => all.find((j) => j.id === job.id));
    expect(stored).toEqual(updated);
  });

  it('無い id は null——mutate は呼ばれない', async () => {
    let called = false;
    const result = await stores.jobs.updateJob('no-such-job', (current) => {
      called = true;
      return current;
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it('同じ id に2本 updateJob が来ても、互いの変更を消さない（直列化される）', async () => {
    await stores.jobs.putJob(job);

    const [a, b] = await Promise.all([
      stores.jobs.updateJob(job.id, (current) => ({
        ...current,
        summary: '1本目の書き込み',
      })),
      stores.jobs.updateJob(job.id, (current) => ({
        ...current,
        lastReport: '2本目の書き込み',
      })),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const stored = await stores.jobs.listJobs().then((all) => all.find((j) => j.id === job.id));
    expect(stored?.summary).toBe('1本目の書き込み');
    expect(stored?.lastReport).toBe('2本目の書き込み');
  });
});

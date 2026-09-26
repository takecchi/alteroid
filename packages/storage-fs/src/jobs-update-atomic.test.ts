import { beforeEach, describe, expect, it } from 'vitest';

import type { Job } from '@alteroid/core';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * Issue #1674（バグ探し `wbug-jobs` で見つかった lost update）。
 *
 * `ManagerPool.appraise()` は、`#records` に像を持たない委譲（孤児ジョブ）を
 * `listJobs()` で読んでから `putJob()` で書き戻していた。読んでから書くまでの
 * 間に別の書き込みが挟まると、その書き込みは古いスナップショットへ丸ごと
 * 上書きされて消えていた（`ScheduleStore.editRequest`（#1654）と同じ形）。
 *
 * `JobStore.updateJob()` はこの「読んでから書く」をストア側の排他区間
 * （`FsJobStore` の `withPathLock`）へ引き取る——ここはその歯（fs 実装）。
 */
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

    // `updateJob` を呼ぶ**前**に、別経路の書き込みが割り込んだことを模す
    // （resume が成功して status / sessionId が進んだ、など）。
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

    // 割り込みで進んだ status / sessionId を、`updateJob` が読み直した現在値
    // から引き継いでいること。
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
    // **どちらの回が先でも後でも構わないが、両方の変更が残っていること。**
    // 直列化されていれば、後の回は前の回が書いた現在値から読み直すので、
    // 両方の変更が同じ行に乗る。
    expect(stored?.appraisal).toBe('good');
    expect(stored?.appraisedBy).toBe('clone');
    expect(stored?.lastReport).toBe('2本目の書き込み');
  });
});

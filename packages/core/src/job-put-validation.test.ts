import { describe, expect, it } from 'vitest';

import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * `JobStore.putJob()` の3実装の食い違い（issue #1715、#1652 の続き）。
 *
 * fs / pg の `putJob()` は `jobSchema.parse(job)` を通してから書く
 * （`packages/storage-fs/src/jobs.ts` の `putJob()`。逐語は
 * `grep -Fn -- 'jobs.push(jobSchema.parse(job));' packages/storage-fs/src/jobs.ts`）。
 * **インメモリ実装だけが検査を持たず**、`jobs.set(job.id, isolate(job));` を
 * 素通しで呼ぶだけだった——同じメモリの `updateJob()` はすでに
 * `jobSchema.parse(mutate(isolate(found)))` を通しているので、**同じストアの
 * 中で `putJob` だけが食い違っていた**（#1652 と同じ族。あちらは
 * `ScheduleStore` / `TokenPoolStore` / `CommitmentStore` / `InboxStore` を
 * 扱い、`AuthStore` / `CredentialVaultStore` / `JobStore` は範囲外としていた）。
 *
 * ここは fs / pg を基準にした期待値（形式不正な job は throw する）を
 * インメモリにも当てる歯——`createMemoryStores()` の `jobs.putJob` が
 * `jobSchema.parse` を通すようになったので緑になる
 * （`packages/storage-fs/src/job-put-validation.test.ts` /
 * `packages/storage-pg/src/job-put-validation.test.ts` と同じ形）。
 */
describe('JobStore.putJob() — 形式不正な job の扱い（インメモリ実装）', () => {
  // `status` は jobStatusSchema（固定の enum）が要求する形を外れる——TS の
  // 型では弾けない違反（実行時にしか検査できない）なので `as unknown as Job`
  // で型を通す。他の必須欄（`id` / `createdAt` / `updatedAt` / `summary`）は
  // 有効な値のまま——検査したいのは `status` 単独の違反である。
  const invalidJob = {
    id: 'mgr-invalid',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'not-a-real-status',
    summary: '不正な job',
  } as unknown as Job;

  it('putJob() は fs / pg と同じく、未知の status を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await expect(stores.jobs.putJob(invalidJob)).rejects.toThrow();
  });
});

import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

/**
 * `ScheduleStore.put()` の3実装の食い違い（issue #1652）。
 *
 * fs / pg の `put()` は `scheduledRequestSchema.parse(entry)` を通してから
 * 書く（`packages/storage-fs/src/schedules.ts` の `put()` / `packages/storage-pg
 * /src/schedules.ts` の `put()`）。**インメモリ実装だけが検査を持たず**、
 * `request` が `scheduledRequestSchema`（`request: z.string().min(1)`）に
 * 落ちる形式不正な entry もそのまま保存していた——#1634/#1635/#1640
 * （`PersonaStore` の slug 検査が実装ごとに違っていた）と同じ形。
 *
 * ここは fs / pg を基準にした期待値（形式不正な entry は throw する）を
 * インメモリにも当てる歯——`createMemoryStores()` の `scheduleStore.put`
 * が `scheduledRequestSchema.parse` を通すようになったので緑になる
 * （`packages/storage-fs/src/schedule-put-validation.test.ts` /
 * `packages/storage-pg/src/schedule-put-validation.test.ts` と同じ形）。
 */
describe('ScheduleStore.put() — 形式不正な entry の扱い（インメモリ実装）', () => {
  const now = new Date().toISOString();
  const invalidEntry = {
    kind: 'daily-report',
    spec: { type: 'every' as const, minutes: 60 },
    request: '', // scheduledRequestSchema は request を min(1) で要求する
    createdAt: now,
    updatedAt: now,
  };

  it('put() は fs / pg と同じく、空文字の request を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await expect(stores.schedules.put(invalidEntry)).rejects.toThrow();
  });
});

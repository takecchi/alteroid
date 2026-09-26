import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1652。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/schedule-put-validation.test.ts` の冒頭コメントを見よ。
 *
 * ここは fs 実装に対して同じ入力を当てる——`put()` が
 * `scheduledRequestSchema.parse(entry)` を通すので、この歯は緑になる。
 */
describe('ScheduleStore.put() — 形式不正な entry の扱い（fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

  const now = new Date().toISOString();
  const invalidEntry = {
    kind: 'daily-report',
    spec: { type: 'every' as const, minutes: 60 },
    request: '', // scheduledRequestSchema は request を min(1) で要求する
    createdAt: now,
    updatedAt: now,
  };

  it('put() は空文字の request を拒む（throw する）', async () => {
    await expect(stores.schedules.put(invalidEntry)).rejects.toThrow();
  });
});

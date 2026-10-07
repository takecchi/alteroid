import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

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
    request: '',
    createdAt: now,
    updatedAt: now,
  };

  it('put() は空文字の request を拒む（throw する）', async () => {
    await expect(stores.schedules.put(invalidEntry)).rejects.toThrow();
  });
});

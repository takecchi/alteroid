import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

describe('ScheduleStore.put() — 形式不正な entry の扱い（インメモリ実装）', () => {
  const now = new Date().toISOString();
  const invalidEntry = {
    kind: 'daily-report',
    spec: { type: 'every' as const, minutes: 60 },
    request: '',
    createdAt: now,
    updatedAt: now,
  };

  it('put() は fs / pg と同じく、空文字の request を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await expect(stores.schedules.put(invalidEntry)).rejects.toThrow();
  });
});

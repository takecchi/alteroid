import { describe, expect, it } from 'vitest';

import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('JobStore.putJob() — 形式不正な job の扱い（インメモリ実装）', () => {
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

import { beforeEach, describe, expect, it } from 'vitest';

import type { Job } from '@alteroid/core';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('JobStore.putJob() — 形式不正な job の扱い（fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

  const invalidJob = {
    id: 'mgr-invalid',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'not-a-real-status',
    summary: '不正な job',
  } as unknown as Job;

  it('putJob() は未知の status を拒む（throw する）', async () => {
    await expect(stores.jobs.putJob(invalidJob)).rejects.toThrow();
  });
});

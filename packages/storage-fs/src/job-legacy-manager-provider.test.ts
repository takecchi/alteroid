import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { jobSchema } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

let root: string;

beforeEach(async () => {
  root = await makeTempDir('alteroid-test-');
});

const LEGACY_JOB = {
  id: 'mgr-legacy-codex',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  status: 'done',
  summary: 'codex を指名して起こした時代の行',
  runnerId: 'runner-a',
  managerProvider: 'codex',
};

describe('managerProvider を持つ過去の委譲の行が読める（2026-10-07 の撤去）', () => {
  it('jobSchema は欄を捨てて読む（.strict() ではない）', () => {
    const parsed = jobSchema.safeParse(LEGACY_JOB);
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'managerProvider' in parsed.data).toBe(false);
  });

  it('listJobs() は unreadable にせず返す', async () => {
    const stores = createFsStores(root);
    await stores.jobs.putJob({
      id: 'mgr-seed',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      status: 'done',
      summary: '正常な行',
    });
    const path = join(root, 'jobs', 'jobs.json');
    const raw = JSON.parse(await readFile(path, 'utf8')) as { jobs: unknown[] };
    raw.jobs.push(LEGACY_JOB);
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const fresh = createFsStores(root);
    expect(await fresh.jobs.listUnreadableJobs()).toEqual([]);
    const jobs = await fresh.jobs.listJobs();
    expect(jobs.map((job) => job.id).sort()).toEqual(['mgr-legacy-codex', 'mgr-seed']);
    const legacy = jobs.find((job) => job.id === 'mgr-legacy-codex');
    expect(legacy?.summary).toBe('codex を指名して起こした時代の行');
    expect(legacy).not.toHaveProperty('managerProvider');
  });
});

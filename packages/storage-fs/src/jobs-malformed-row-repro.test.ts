import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import type { Job } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('FsJobStore — jobs.json の不正な1行を読み飛ばす（issue #1868）', () => {
  let root: string;
  let jobsPath: string;

  const GOOD_JOB: Job = {
    id: 'mgr-good',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'done',
    summary: '正常な job の本文（この文字列がそのまま跡に出てはいけない）',
  };

  const BAD_JOB_RAW = {
    id: 'mgr-bad',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    status: 'not-a-real-status-from-a-newer-deploy',
    summary: '壊れた job の本文（この文字列も跡に出てはいけない）',
  };

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    jobsPath = join(root, 'jobs', 'jobs.json');
  });

  async function writeRawJobsFile(): Promise<void> {
    const stores = createFsStores(root);
    await stores.jobs.putJob(GOOD_JOB);
    const raw = JSON.parse(await readFile(jobsPath, 'utf8')) as { jobs: unknown[] };
    raw.jobs.push(BAD_JOB_RAW);
    await writeFile(jobsPath, `${JSON.stringify(raw, null, 2)}\n`);
  }

  function findRowById(rows: unknown[], id: string): unknown {
    return rows.find(
      (row) => typeof row === 'object' && row !== null && (row as { id?: unknown }).id === id,
    );
  }

  it('listJobs() は不正な行を飛ばし、正しい行だけを返す（直す前は例外で赤）', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    let found: Job[] = [];
    await captureStderr(async () => {
      found = await stores.jobs.listJobs();
    });

    expect(found.map((j) => j.id)).toEqual(['mgr-good']);
  });

  it('跡: 飛ばした行を stderr へ1行出す。本文（summary）の値は絶対に含めない', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await stores.jobs.listJobs();
    });
    const joined = lines.join('');

    expect(joined).toContain('mgr-bad');
    expect(joined).not.toContain(GOOD_JOB.summary);
    expect(joined).not.toContain(BAD_JOB_RAW.summary);
  });

  it('listUnreadableJobs() は飛ばした行を id と不正な欄名だけで返す（本文は載せない）（issue #2345）', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    let unreadable: Awaited<ReturnType<typeof stores.jobs.listUnreadableJobs>> = [];
    await captureStderr(async () => {
      unreadable = await stores.jobs.listUnreadableJobs();
    });

    expect(unreadable).toEqual([{ id: 'mgr-bad', reason: '不正な欄: status' }]);
    expect(JSON.stringify(unreadable)).not.toContain(BAD_JOB_RAW.summary);
    expect(JSON.stringify(unreadable)).not.toContain(GOOD_JOB.summary);
  });

  it('対照: 不正な行が無ければ listUnreadableJobs() は空（issue #2345）', async () => {
    const stores = createFsStores(root);
    expect(await stores.jobs.listUnreadableJobs()).toEqual([]);
    await stores.jobs.putJob(GOOD_JOB);
    expect(await stores.jobs.listUnreadableJobs()).toEqual([]);
  });

  it('putJob() は投げない。書いた後のファイルに不正な行が元の形のまま残っている', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    await captureStderr(async () => {
      await expect(
        stores.jobs.putJob({
          id: 'mgr-new',
          createdAt: '2026-09-03T00:00:00.000Z',
          updatedAt: '2026-09-03T00:00:00.000Z',
          status: 'running',
          summary: '新しい job',
        }),
      ).resolves.toBeUndefined();
    });

    const raw = JSON.parse(await readFile(jobsPath, 'utf8')) as { jobs: unknown[] };
    const badRow = findRowById(raw.jobs, 'mgr-bad');

    expect(badRow).toEqual(BAD_JOB_RAW);

    let found: Job[] = [];
    await captureStderr(async () => {
      found = await stores.jobs.listJobs();
    });
    expect(found.map((j) => j.id).sort()).toEqual(['mgr-good', 'mgr-new']);
  });

  it('putJob() は、書き込む id と一致する不正な行を置き換える（元の壊れた行とは共存しない）', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    await captureStderr(() =>
      stores.jobs.putJob({
        id: 'mgr-bad',
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-04T00:00:00.000Z',
        status: 'done',
        summary: '直した job',
      }),
    );

    const raw = JSON.parse(await readFile(jobsPath, 'utf8')) as { jobs: unknown[] };
    const rowsWithId = raw.jobs.filter(
      (row) =>
        typeof row === 'object' && row !== null && (row as { id?: unknown }).id === 'mgr-bad',
    );

    expect(rowsWithId).toHaveLength(1);
    expect(rowsWithId[0]).toMatchObject({ id: 'mgr-bad', status: 'done', summary: '直した job' });

    const lines = await captureStderr(async () => {
      const found = await stores.jobs.listJobs();
      expect(found.map((j) => j.id).sort()).toEqual(['mgr-bad', 'mgr-good']);
    });
    expect(lines).toHaveLength(0);
  });

  it('clear() は正しい行も壊れた行も両方消す——jobs.json に委譲の行が1つも残らない（issue #1868）', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    let removed: { jobs: number; approvals: number } = { jobs: -1, approvals: -1 };
    await captureStderr(async () => {
      removed = await stores.jobs.clear();
    });
    expect(removed).toEqual({ jobs: 2, approvals: 0 });

    const raw = JSON.parse(await readFile(jobsPath, 'utf8')) as { jobs: unknown[] };
    expect(raw.jobs).toEqual([]);

    let found: Job[] = [];
    await captureStderr(async () => {
      found = await stores.jobs.listJobs();
    });
    expect(found).toEqual([]);
  });
});

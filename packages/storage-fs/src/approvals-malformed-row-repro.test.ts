import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, UnreadableApprovalError } from '@alteroid/core';
import type { PendingApproval } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('FsJobStore — jobs.json の approvals の不正な1行を読み飛ばす（issue #1928）', () => {
  let root: string;
  let jobsPath: string;

  const GOOD_APPROVAL: PendingApproval = {
    id: 'appr-good',
    createdAt: '2026-09-01T00:00:00.000Z',
    question: '正常な承認待ちの本文（この文字列がそのまま跡に出てはいけない）',
  };

  const BAD_APPROVAL_RAW = {
    id: 'appr-bad',
    createdAt: '2026-09-02T00:00:00.000Z',
    context: '壊れた承認待ちの本文（この文字列も跡に出てはいけない）',
  };

  const GOOD_JOB = {
    id: 'mgr-good',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'done' as const,
    summary: '正常な job の本文',
  };

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    jobsPath = join(root, 'jobs', 'jobs.json');
  });

  async function writeRawJobsFile(): Promise<void> {
    const stores = createFsStores(root);
    await stores.jobs.putJob(GOOD_JOB);
    await stores.jobs.putApproval(GOOD_APPROVAL);
    const raw = JSON.parse(await readFile(jobsPath, 'utf8')) as {
      jobs: unknown[];
      approvals: unknown[];
    };
    raw.approvals.push(BAD_APPROVAL_RAW);
    await writeFile(jobsPath, `${JSON.stringify(raw, null, 2)}\n`);
  }

  function findRowById(rows: unknown[], id: string): unknown {
    return rows.find(
      (row) => typeof row === 'object' && row !== null && (row as { id?: unknown }).id === id,
    );
  }

  it('listJobs() は、approvals に不正な行があっても落ちず、正しい job を返す', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    let found: unknown[] = [];
    await captureStderr(async () => {
      found = await stores.jobs.listJobs();
    });

    expect(found.map((j) => (j as { id: string }).id)).toEqual(['mgr-good']);
  });

  it('listApprovals() は不正な行を飛ばし、正しい行だけを返す（直す前は例外で赤）', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    let found: PendingApproval[] = [];
    await captureStderr(async () => {
      found = (await stores.jobs.listApprovals()).entries;
    });

    expect(found.map((a) => a.id)).toEqual(['appr-good']);
  });

  it('跡: 飛ばした approval の行を stderr へ1行出す。本文（question/context）の値は絶対に含めない', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await stores.jobs.listApprovals();
    });
    const joined = lines.join('');

    expect(joined).toContain('appr-bad');
    expect(joined).not.toContain(GOOD_APPROVAL.question);
    expect(joined).not.toContain(BAD_APPROVAL_RAW.context);
  });

  it('getApproval() は、不正な行を id 指定すると null ではなく UnreadableApprovalError を投げる。正しい行は返し、無い id は null（#2279）', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    let good: PendingApproval | null = null;
    let missing: PendingApproval | null = null;
    let thrown: unknown;
    await captureStderr(async () => {
      good = await stores.jobs.getApproval('appr-good');
      missing = await stores.jobs.getApproval('appr-nowhere');
      try {
        await stores.jobs.getApproval('appr-bad');
      } catch (error) {
        thrown = error;
      }
    });

    expect(good).toEqual(GOOD_APPROVAL);
    expect(missing).toBeNull();
    expect(thrown).toBeInstanceOf(UnreadableApprovalError);
  });

  it('putApproval() は投げない。書いた後のファイルに不正な行が元の形のまま残っている', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    const NEW_APPROVAL: PendingApproval = {
      id: 'appr-new',
      createdAt: '2026-09-03T00:00:00.000Z',
      question: '新しい承認待ち',
    };

    await captureStderr(async () => {
      await expect(stores.jobs.putApproval(NEW_APPROVAL)).resolves.toBeUndefined();
    });

    const raw = JSON.parse(await readFile(jobsPath, 'utf8')) as { approvals: unknown[] };
    const badRow = findRowById(raw.approvals, 'appr-bad');

    expect(badRow).toEqual(BAD_APPROVAL_RAW);

    let found: PendingApproval[] = [];
    await captureStderr(async () => {
      found = (await stores.jobs.listApprovals()).entries;
    });
    expect(found.map((a) => a.id).sort()).toEqual(['appr-good', 'appr-new']);
  });

  it('putApproval() は、書き込む id と一致する不正な行を置き換える（元の壊れた行とは共存しない）', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    await captureStderr(() =>
      stores.jobs.putApproval({
        id: 'appr-bad',
        createdAt: '2026-09-02T00:00:00.000Z',
        question: '直した承認待ち',
      }),
    );

    const raw = JSON.parse(await readFile(jobsPath, 'utf8')) as { approvals: unknown[] };
    const rowsWithId = raw.approvals.filter(
      (row) =>
        typeof row === 'object' && row !== null && (row as { id?: unknown }).id === 'appr-bad',
    );

    expect(rowsWithId).toHaveLength(1);
    expect(rowsWithId[0]).toMatchObject({ id: 'appr-bad', question: '直した承認待ち' });

    const lines = await captureStderr(async () => {
      const found = (await stores.jobs.listApprovals()).entries;
      expect(found.map((a) => a.id).sort()).toEqual(['appr-bad', 'appr-good']);
    });
    expect(lines).toHaveLength(0);
  });

  it('clear() は正しい approval も壊れた approval も両方消す——jobs.json に承認待ちの行が1つも残らない', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    let removed: { jobs: number; approvals: number } = { jobs: -1, approvals: -1 };
    await captureStderr(async () => {
      removed = await stores.jobs.clear();
    });
    expect(removed).toEqual({ jobs: 1, approvals: 2 });

    const raw = JSON.parse(await readFile(jobsPath, 'utf8')) as { approvals: unknown[] };
    expect(raw.approvals).toEqual([]);

    let found: PendingApproval[] = [];
    await captureStderr(async () => {
      found = (await stores.jobs.listApprovals()).entries;
    });
    expect(found).toEqual([]);
  });
});

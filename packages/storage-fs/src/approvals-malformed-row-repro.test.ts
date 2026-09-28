import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import type { PendingApproval } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1928（#1868 で残された approvals 側）。`FsJobStore#read()` の
 * `fileSchema` は、`jobs` 側は #1868（PR #1884）で `z.array(z.unknown())` に
 * 直り、行ごとに `jobSchema.safeParse` するようになったが、`approvals` は
 * `z.array(pendingApprovalSchema)` のままで、配列全体を1回で検査している。
 *
 * そのため、**承認待ちの行が1行でも `pendingApprovalSchema` に合わなければ
 * `ZodError` が投げられ、`listApprovals()` だけでなく `listJobs()` /
 * `putJob()` / `getApproval()` / `putApproval()` / `clear()` まで、同じ
 * `jobs.json` を読む操作がすべて落ちる**——`#read()` が1回しかないので、
 * jobs 側を直しても approvals 側の壊れた行が全体を道連れにする。
 *
 * ここでは pg 版の `PgJobStore.listApprovals` / `getApproval`（既に1行ずつ
 * `safeParse` している）・fs の jobs 側（#1868）と同じ「その行だけを飛ばし、
 * 残りは返す。書き戻しでは元の形のまま保つ」に approvals 側もそろえる
 * ことを確かめる。
 */
describe('FsJobStore — jobs.json の approvals の不正な1行を読み飛ばす（issue #1928）', () => {
  let root: string;
  let jobsPath: string;

  const GOOD_APPROVAL: PendingApproval = {
    id: 'appr-good',
    createdAt: '2026-09-01T00:00:00.000Z',
    question: '正常な承認待ちの本文（この文字列がそのまま跡に出てはいけない）',
  };

  // `question`（必須欄）が欠けている——版ずれ（新しいデーモンが先に書いた
  // 欄を古いデーモンがまだ知らない）・手編集を模す。
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

  /**
   * jobs.json を、正しい job 1件・正しい approval 1件・schema に合わない
   * approval 1件で直接作る（手編集・版ずれを模す）。
   */
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
      found = await stores.jobs.listApprovals();
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

    // 位置・id は載ってよい。
    expect(joined).toContain('appr-bad');
    // **本文（question/context）は絶対に出ない**（正常行・壊れた行のどちらの値も）。
    expect(joined).not.toContain(GOOD_APPROVAL.question);
    expect(joined).not.toContain(BAD_APPROVAL_RAW.context);
  });

  it('getApproval() は、不正な行を id 指定しても例外を投げず null を返す。正しい行は返す', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    let good: PendingApproval | null = null;
    let bad: PendingApproval | null = null;
    await captureStderr(async () => {
      good = await stores.jobs.getApproval('appr-good');
      bad = await stores.jobs.getApproval('appr-bad');
    });

    expect(good).toEqual(GOOD_APPROVAL);
    expect(bad).toBeNull();
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

    // **元の形のまま**——書き換えられず、消えてもいない（別の id を put しただけ）。
    expect(badRow).toEqual(BAD_APPROVAL_RAW);

    let found: PendingApproval[] = [];
    await captureStderr(async () => {
      found = await stores.jobs.listApprovals();
    });
    expect(found.map((a) => a.id).sort()).toEqual(['appr-good', 'appr-new']);
  });

  it('putApproval() は、書き込む id と一致する不正な行を置き換える（元の壊れた行とは共存しない）', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    // 壊れた行と同じ id（appr-bad）で、正しい approval を put する——「直した」つもり。
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

    // **その id は1行だけ**（新しい値)——古い壊れた行と共存しない。
    expect(rowsWithId).toHaveLength(1);
    expect(rowsWithId[0]).toMatchObject({ id: 'appr-bad', question: '直した承認待ち' });

    // 直したので、次の listApprovals() では跡が1行も出ない。
    const lines = await captureStderr(async () => {
      const found = await stores.jobs.listApprovals();
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
    // jobs 側（#1868 / #1892）と同じく、消えた行すべてを数える——正しい行
    // だけを数えると、pg の `DELETE … RETURNING` の件数（壊れているかに
    // 関係なく消した行数）と食い違う。
    expect(removed).toEqual({ jobs: 1, approvals: 2 });

    const raw = JSON.parse(await readFile(jobsPath, 'utf8')) as { approvals: unknown[] };
    // **不正な行ごと消える**——ファイルに承認待ちの行が1つも残らない。
    expect(raw.approvals).toEqual([]);

    let found: PendingApproval[] = [];
    await captureStderr(async () => {
      found = await stores.jobs.listApprovals();
    });
    expect(found).toEqual([]);
  });
});

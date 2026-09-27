import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import type { Job } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1868。`FsJobStore#read()` は以前 `fileSchema.parse` で jobs.json の
 * `jobs` 配列全体を1回に検査していたため、1行でも `jobSchema` に合わないと
 * `listJobs()` が丸ごと例外を投げ、正しい job も読めなくなっていた——
 * pg 実装は issue #224 の作法（`noteDroppedJournalRow`）で1行だけ飛ばしていた
 * ので、fs だけがこの穴を持っていた。
 *
 * ここでは pg 版 / `FsCredentialVaultStore`（issue #1740）が既に持っている
 * 「その行だけを飛ばし、残りは返す。書き戻しでは元の形のまま保つ」に fs の
 * jobs 実装をそろえたことを確かめる。**承認待ちキュー（approvals）はこの
 * Issue の担当範囲外——挙動は変えていない。**
 */
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

  // status が jobStatusSchema に無い値——版ずれ（新しいデーモンが先に書いた
  // status を、古いデーモンがまだ知らない）・手編集を模す。
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

  /** jobs.json を、正常な job 1件 + 壊れた job 1件で直接作る（手編集・版ずれを模す）。 */
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

    // 位置・id は載ってよい。
    expect(joined).toContain('mgr-bad');
    // **本文（summary）は絶対に出ない**（正常行・壊れた行のどちらの値も）。
    expect(joined).not.toContain(GOOD_JOB.summary);
    expect(joined).not.toContain(BAD_JOB_RAW.summary);
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

    // **元の形のまま**——書き換えられず、消えてもいない（別の id を put しただけ）。
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

    // 壊れた行と同じ id（mgr-bad）で、正しい job を put する——「直した」つもり。
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

    // **その id は1行だけ**（新しい値）——古い壊れた行と共存しない。
    expect(rowsWithId).toHaveLength(1);
    expect(rowsWithId[0]).toMatchObject({ id: 'mgr-bad', status: 'done', summary: '直した job' });

    // 直したので、次の listJobs() では跡が1行も出ない。
    const lines = await captureStderr(async () => {
      const found = await stores.jobs.listJobs();
      expect(found.map((j) => j.id).sort()).toEqual(['mgr-bad', 'mgr-good']);
    });
    expect(lines).toHaveLength(0);
  });

  // 以前はここで「clear() は正しい行を消すが、壊れた行は（消せないので）
  // 元の形のまま残す」を確かめていた——`invalidJobsRaw` を消さずに持ち回る
  // 実装が正しいという前提だった。だが `JobStore.clear()` の doc は
  // 「委譲と承認待ちを両方消す」であり、pg 実装の `clear()` は表の行を
  // `DELETE` で全部消すので不正な行も一緒に消える——fs だけが不正な行を
  // 残すのは pg との非対称で、#1868 の直しの範囲として一緒に塞いだ
  // （この歯は直す前の `b1f410f` の版では赤——`raw.jobs` に `mgr-bad` の行が
  // 残るので `toEqual([])` に落ちる）。
  it('clear() は正しい行も壊れた行も両方消す——jobs.json に委譲の行が1つも残らない（issue #1868）', async () => {
    await writeRawJobsFile();
    const stores = createFsStores(root);

    let removed: { jobs: number; approvals: number } = { jobs: -1, approvals: -1 };
    await captureStderr(async () => {
      removed = await stores.jobs.clear();
    });
    // 件数は**消えた行すべて**を数える（issue #1892）。#1868 の時点ではここを
    // `{ jobs: 1, approvals: 0 }`（正しい行だけ）と期待していたが、それは
    // 「2行消したのに1と返す」非対称をテストで固定していた——pg の
    // `PgJobStore.clear` は `DELETE … RETURNING` で行の中身が壊れているかに
    // 関係なく消した行数を返すので、同じ状態で fs と pg の件数が食い違う。
    // 下の「ファイルに委譲の行が1つも残らない」と合わせて、消した行と
    // 数えた行が一致することを見る（期待値を反転しただけで、確かめる範囲は
    // 狭めていない）。
    expect(removed).toEqual({ jobs: 2, approvals: 0 });

    const raw = JSON.parse(await readFile(jobsPath, 'utf8')) as { jobs: unknown[] };
    // **不正な行ごと消える**——ファイルに委譲の行が1つも残らない。
    expect(raw.jobs).toEqual([]);

    let found: Job[] = [];
    await captureStderr(async () => {
      found = await stores.jobs.listJobs();
    });
    expect(found).toEqual([]);
  });
});

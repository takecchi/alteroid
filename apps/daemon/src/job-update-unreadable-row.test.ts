import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import type { Job } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import {
  createPgStoresFromDb,
  migrate,
  tables,
  type Db,
  type PgStores,
} from '@alteroid/storage-pg';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

/**
 * `JobStore.updateJob()` の、読めない（`jobSchema` に合わない）行に対する
 * 扱いの食い違い（issue #2051）。
 *
 * pg 実装（`PgJobStore.updateJob`）は `jobSchema.parse(row.job)` を使っていた
 * ため、版ずれ・手編集でできた不正な行を渡された `mutate` を1回も呼ばずに
 * `ZodError` を投げていた——同じ `PgJobStore` の `listJobs()`
 * （`jobSchema.safeParse` で飛ばす）とも、fs 実装の `FsJobStore.updateJob`
 * （検査を通った行からしか探さないので「無い」と同じ扱いになる）とも食い違って
 * いた。この歯は、fs（既存の直った挙動）と pg（この直しの対象）を並べて、
 * どちらも「読めない行は `null`。`mutate` は呼ばれない。行は書き換えない」を
 * 満たすことを確かめる。
 *
 * **メモリ実装（`createMemoryStores`）はここに並べない。** `packages/core/
 * src/testing.ts` の `putJob` は既に `jobSchema.parse` を書き込み時に通す
 * （issue #1715）ので、そもそも壊れた行を保持できない——ここで確かめたい
 * 「既に壊れて保存されている行を読むとき」の状態を作れないため、対象は
 * fs / pg の2実装だけにしてある。
 */
describe('JobStore.updateJob() — 読めない job 行の扱い（issue #2051）', () => {
  // status が jobStatusSchema に無い値——版ずれ（新しいデーモンが先に書いた
  // status を、古いデーモンがまだ知らない）・手編集を模す
  // （`packages/storage-fs/src/jobs-malformed-row-repro.test.ts` の
  // `BAD_JOB_RAW` と同じ形）。
  const BAD_JOB_RAW = {
    id: 'mgr-bad',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    status: 'not-a-real-status-from-a-newer-deploy',
    summary: '壊れた job の本文（この文字列は跡に出てはいけない）',
  };

  describe('fs 実装', () => {
    it('updateJob() は読めない行を null として扱う。mutate は呼ばれず、行は書き換えられない', async () => {
      const root = await makeTempDir('alteroid-test-');
      const dir = join(root, 'jobs');
      const jobsPath = join(dir, 'jobs.json');
      await mkdir(dir, { recursive: true });
      await writeFile(
        jobsPath,
        `${JSON.stringify({ jobs: [BAD_JOB_RAW], approvals: [] }, null, 2)}\n`,
      );

      const stores = createFsStores(root);
      let called = false;
      let result: Job | null = null;
      await captureStderr(async () => {
        result = await stores.jobs.updateJob(BAD_JOB_RAW.id, (current) => {
          called = true;
          return current;
        });
      });

      expect(result).toBeNull();
      expect(called).toBe(false);

      const raw = JSON.parse(await readFile(jobsPath, 'utf8')) as { jobs: unknown[] };
      // 行は元の形のまま——書き換えられず、消えてもいない。
      expect(raw.jobs).toEqual([BAD_JOB_RAW]);
    });
  });

  describe('pg 実装', () => {
    let client: PGlite;
    let db: Db;
    let stores: PgStores;

    afterEach(async () => {
      await client.close();
    });

    it('updateJob() は読めない行を null として扱う（直す前は ZodError を投げる）。mutate は呼ばれず、行は書き換えられない', async () => {
      client = new PGlite();
      db = drizzle(client);
      await migrate(db);
      stores = createPgStoresFromDb(db);

      // 行を直接 insert する——`putJob()` を経由すると `jobSchema.parse` を
      // 通ってしまい、壊れた行を作れない（`PgJobStore.putJob` の doc）。
      await db.insert(tables.jobs).values({
        id: BAD_JOB_RAW.id,
        status: BAD_JOB_RAW.status,
        createdAt: new Date(BAD_JOB_RAW.createdAt),
        updatedAt: new Date(BAD_JOB_RAW.updatedAt),
        job: BAD_JOB_RAW,
      });

      let called = false;
      let result: Job | null = null;
      let thrown: unknown;
      const lines = await captureStderr(async () => {
        try {
          result = await stores.jobs.updateJob(BAD_JOB_RAW.id, (current) => {
            called = true;
            return current;
          });
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toBeUndefined();
      expect(result).toBeNull();
      expect(called).toBe(false);

      // 跡: id は出るが本文（summary）は絶対に出ない。
      const joined = lines.join('');
      expect(joined).toContain(BAD_JOB_RAW.id);
      expect(joined).not.toContain(BAD_JOB_RAW.summary);

      // 行は書き換えられない。
      const rows = await db.select().from(tables.jobs);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.job).toEqual(BAD_JOB_RAW);
    });
  });
});

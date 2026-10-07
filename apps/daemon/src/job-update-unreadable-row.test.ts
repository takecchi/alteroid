import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, UnreadableJobError } from '@alteroid/core';
import type { Job } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables, type Db, type PgStores } from '@alteroid/storage-pg';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

const BAD_JOB_RAW = {
  id: 'mgr-bad',
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  status: 'not-a-real-status-from-a-newer-deploy',
  summary: '壊れた job の本文（この文字列は跡に出てはいけない）',
};

describe('JobStore.updateJob() — 読めない job 行の扱い', () => {
  // 雛形の払いは歯の本体（既定 5000ms）でなく hook（30_000ms）に持たせる: WASM の起動＋migrate がワーカーで最初に呼んだ歯に乗るため。
  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  describe('fs 実装', () => {
    async function seed() {
      const root = await makeTempDir('alteroid-test-');
      const dir = join(root, 'jobs');
      const jobsPath = join(dir, 'jobs.json');
      await mkdir(dir, { recursive: true });
      await writeFile(
        jobsPath,
        `${JSON.stringify({ jobs: [BAD_JOB_RAW], approvals: [] }, null, 2)}\n`,
      );
      return { root, jobsPath, stores: createFsStores(root) };
    }

    it('updateJob() は読めない行で UnreadableJobError を投げる。mutate は呼ばれず、行は1バイトも変わらず、跡は id だけ', async () => {
      const { jobsPath, stores } = await seed();
      const before = await readFile(jobsPath, 'utf8');

      let called = false;
      let thrown: unknown;
      const lines = await captureStderr(async () => {
        try {
          await stores.jobs.updateJob(BAD_JOB_RAW.id, (current) => {
            called = true;
            return current;
          });
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toBeInstanceOf(UnreadableJobError);
      expect((thrown as UnreadableJobError).id).toBe(BAD_JOB_RAW.id);
      expect((thrown as UnreadableJobError).message).not.toContain(BAD_JOB_RAW.summary);
      expect(called).toBe(false);

      const joined = lines.join('');
      expect(joined).toContain(BAD_JOB_RAW.id);
      expect(joined).not.toContain(BAD_JOB_RAW.summary);

      expect(await readFile(jobsPath, 'utf8')).toBe(before);
    });

    it('本当に無い id は従来どおり null（読めない行と混ざらない）', async () => {
      const { stores } = await seed();
      let result: Job | null | undefined;
      await captureStderr(async () => {
        result = await stores.jobs.updateJob('mgr-nowhere', (current) => current);
      });
      expect(result).toBeNull();
    });
  });

  describe('pg 実装', () => {
    let client: PGlite;
    let db: Db;
    let stores: PgStores;

    afterEach(async () => {
      await client.close();
    });

    async function seed() {
      ({ client, db } = await createMigratedPglite());
      stores = createPgStoresFromDb(db);

      // 行を直接 insert する: `putJob()` を経由すると `jobSchema.parse` を通ってしまい、壊れた行を作れないため。
      await db.insert(tables.jobs).values({
        id: BAD_JOB_RAW.id,
        status: BAD_JOB_RAW.status,
        createdAt: new Date(BAD_JOB_RAW.createdAt),
        updatedAt: new Date(BAD_JOB_RAW.updatedAt),
        job: BAD_JOB_RAW,
      });
    }

    it('updateJob() は読めない行で UnreadableJobError を投げる。mutate は呼ばれず、行は書き換えられず、跡は id だけ', async () => {
      await seed();

      let called = false;
      let thrown: unknown;
      const lines = await captureStderr(async () => {
        try {
          await stores.jobs.updateJob(BAD_JOB_RAW.id, (current) => {
            called = true;
            return current;
          });
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toBeInstanceOf(UnreadableJobError);
      expect((thrown as UnreadableJobError).id).toBe(BAD_JOB_RAW.id);
      expect((thrown as UnreadableJobError).message).not.toContain(BAD_JOB_RAW.summary);
      expect(called).toBe(false);

      const joined = lines.join('');
      expect(joined).toContain(BAD_JOB_RAW.id);
      expect(joined).not.toContain(BAD_JOB_RAW.summary);

      const rows = await db.select().from(tables.jobs);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.job).toEqual(BAD_JOB_RAW);
    });

    it('本当に無い id は従来どおり null（読めない行と混ざらない）', async () => {
      await seed();
      const result = await stores.jobs.updateJob('mgr-nowhere', (current) => current);
      expect(result).toBeNull();
    });
  });
});

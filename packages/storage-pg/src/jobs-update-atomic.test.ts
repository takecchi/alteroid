import type { Job } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * Issue #1674。fs 版（`packages/storage-fs/src/jobs-update-atomic.test.ts`）と
 * 同じ歯を pg 実装（`PgJobStore`）に当てる——`JobStore` は器の違いで能力差を
 * 作らない別のストアなので、両方が同じ形で直っていることを確かめる。
 */
describe('JobStore.updateJob()（pg 実装）', () => {
  let client: PGlite;
  let db: Db;
  let stores: PgStores;

  const job: Job = {
    id: 'mgr-lost',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'lost',
    summary: '調べ物',
    sessionId: 'sess-old',
    runnerId: 'runner-primary',
  };

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client);
    await migrate(db);
    stores = createPgStoresFromDb(db);
  });

  afterEach(async () => {
    await client.close();
  });

  it('現在値を排他区間（select … for update）の中で読み直す——外から先に割り込んだ書き込みは消えない', async () => {
    await stores.jobs.putJob(job);

    // `updateJob` を呼ぶ**前**に、別経路の書き込みが割り込んだことを模す。
    await stores.jobs.putJob({
      ...job,
      status: 'running',
      sessionId: 'sess-new',
      updatedAt: '2026-09-01T00:05:00.000Z',
    });

    const updated = await stores.jobs.updateJob(job.id, (current) => ({
      ...current,
      appraisal: 'good',
      appraisedAt: '2026-09-01T00:10:00.000Z',
      appraisedBy: 'human',
    }));

    expect(updated).toMatchObject({
      status: 'running',
      sessionId: 'sess-new',
      appraisal: 'good',
      appraisedBy: 'human',
    });

    const stored = await stores.jobs.listJobs().then((all) => all.find((j) => j.id === job.id));
    expect(stored).toEqual(updated);
  });

  it('無い id は null——mutate は呼ばれない', async () => {
    let called = false;
    const result = await stores.jobs.updateJob('no-such-job', (current) => {
      called = true;
      return current;
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  // **⚠️ ここは「2本が本当に重なる」ことは測っていない。** `PGlite` は単一
  // コネクションで、`db.transaction()` を2本同時に起こしても内部で直列化される
  // （別途 `node` で実測済み——2本目の `begin` は1本目の `transaction()` が
  // 解決した*後*にしか来ない）。だから `for('update')` を外しても、この
  // `Promise.all` の形では red にならない（本物の重なりが起きないため）。
  // 測っているのは「2本の `updateJob` を順に呼んでも、両方の変更が積み重なる
  // こと」——`select … for update` が本当に排他しているかは、複数コネクションを
  // 持つ本物の PostgreSQL でしか測れない（fs 版は同一プロセス内の複数 Promise で
  // 本物の重なりを作れるので、そちらの歯（`packages/storage-fs/src/
  // jobs-update-atomic.test.ts`）が実際に変異で赤くなることを確かめてある）。
  it('2本の updateJob を順に呼んでも、両方の変更が積み重なる', async () => {
    await stores.jobs.putJob(job);

    const a = await stores.jobs.updateJob(job.id, (current) => ({
      ...current,
      appraisal: 'good',
      appraisedBy: 'clone',
    }));
    const b = await stores.jobs.updateJob(job.id, (current) => ({
      ...current,
      lastReport: '2本目の書き込み',
    }));

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const stored = await stores.jobs.listJobs().then((all) => all.find((j) => j.id === job.id));
    expect(stored?.appraisal).toBe('good');
    expect(stored?.appraisedBy).toBe('clone');
    expect(stored?.lastReport).toBe('2本目の書き込み');
  });
});

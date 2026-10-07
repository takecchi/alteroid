import type { Job } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { jobs } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

const GOOD_JOB: Job = {
  id: 'mgr-tx-good',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  status: 'done',
  summary: '正常な job',
};

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);

  // `db.execute` / `client.query` を使わない: "cannot insert multiple commands into a prepared statement" で落ちるため、`client.exec` を使う。
  await client.exec(`
    CREATE OR REPLACE FUNCTION forbid_approvals_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forbid_approvals_delete: 仕込んだ失敗（issue #1929 の歯）';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await client.exec(`
    CREATE TRIGGER approvals_forbid_delete
      BEFORE DELETE ON approvals
      FOR EACH ROW
      EXECUTE FUNCTION forbid_approvals_delete();
  `);
});

describe('JobStore.clear() — jobs と approvals を1つのトランザクションで消す（issue #1929）', () => {
  it('approvals の DELETE が失敗したら、jobs の DELETE もロールバックされる', async () => {
    await stores.jobs.putJob(GOOD_JOB);
    await stores.jobs.putApproval({
      id: 'appr-tx-1',
      createdAt: '2026-09-01T00:00:00.000Z',
      question: '確認してほしい',
    });

    // 例外の中身を見る: ほかの理由で先に落ちても行は残り、緑になってしまうため。drizzle は例外を `Failed query: <SQL>` で包むので SQL の側で見る。
    await expect(stores.jobs.clear()).rejects.toThrow(/Failed query: delete from "approvals"/);

    const remainingJobs = await db.select().from(jobs);
    expect(remainingJobs.map((row) => row.id)).toEqual(['mgr-tx-good']);
  });
});

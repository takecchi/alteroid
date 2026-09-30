import type { Job } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { jobs } from './schema.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * issue #1929。`JobStore.clear()` の契約は「jobs と approvals を一緒に1操作で
 * 消す」（`packages/core/src/store.ts` の `JobStore.clear` の doc）。
 *
 * `approvals` への DELETE だけが失敗するよう BEFORE DELETE トリガを仕込み、
 * `clear()` が例外を投げた後に **jobs の行が残っている**（＝ロールバック
 * された）ことを見る。1つのトランザクションで束ねていない実装
 * （直す前の `PgJobStore.clear()`）は、jobs の DELETE を確定させたあとで
 * approvals の DELETE に失敗するので、この歯は赤くなる。
 */
let client: PGlite;
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
  ({ client, db } = await createMigratedPglite());
  stores = createPgStoresFromDb(db);

  // approvals への DELETE だけを確実に失敗させる（BEFORE DELETE トリガ）。
  // `client.exec`（複数文を1回で流せる）を使う——`db.execute` / `client.query`
  // は "cannot insert multiple commands into a prepared statement" で落ちる
  // （実測。prepared statement 経路は単一コマンドしか受けない）。
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

    // approvals の DELETE で落ちたことまで見る。ほかの理由で jobs の DELETE の
    // 前に落ちても jobs は残るので、例外の中身を見ないと緑になってしまう。
    // drizzle は仕込んだ例外を `Failed query: <SQL>` で包むので、SQL の側で見る。
    await expect(stores.jobs.clear()).rejects.toThrow(/Failed query: delete from "approvals"/);

    // ロールバックされていれば、jobs の行は消えずに残っているはず。
    const remainingJobs = await db.select().from(jobs);
    expect(remainingJobs.map((row) => row.id)).toEqual(['mgr-tx-good']);
  });
});

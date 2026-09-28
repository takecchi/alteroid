import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';
import { schedules } from './schema.js';

/**
 * issue #1955（#1929 の同じ形の残り）。`ScheduleStore.clear()` の契約は「継続中の
 * 依頼と既定の仕込みの位相を一緒に1操作で消す」（`packages/core/src/store.ts` の
 * `ScheduleStore.clear` の doc）。
 *
 * `schedule_phases` への DELETE だけが失敗するよう BEFORE DELETE トリガを仕込み、
 * `clear()` が例外を投げた後に **schedules の行が残っている**（＝ロールバックされた）
 * ことを見る。1つのトランザクションで束ねていない実装（直す前の
 * `PgScheduleStore.clear()`）は、schedules の DELETE を確定させたあとで
 * schedule_phases の DELETE に失敗するので、この歯は赤くなる。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

const PLAN = {
  kind: 'issue-round',
  spec: { type: 'daily' as const, at: '09:00' },
  request: 'open issue を見て実装を進める',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
  stores = createPgStoresFromDb(db);

  // schedule_phases への DELETE だけを確実に失敗させる（BEFORE DELETE トリガ）。
  // `client.exec`（複数文を1回で流せる）を使う——`db.execute` / `client.query`
  // は "cannot insert multiple commands into a prepared statement" で落ちる
  // （jobs-clear-tx.test.ts と同じ実測）。
  await client.exec(`
    CREATE OR REPLACE FUNCTION forbid_schedule_phases_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forbid_schedule_phases_delete: 仕込んだ失敗（issue #1955 の歯）';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await client.exec(`
    CREATE TRIGGER schedule_phases_forbid_delete
      BEFORE DELETE ON schedule_phases
      FOR EACH ROW
      EXECUTE FUNCTION forbid_schedule_phases_delete();
  `);
});

describe('ScheduleStore.clear() — 依頼と位相を1つのトランザクションで消す（issue #1955）', () => {
  it('schedule_phases の DELETE が失敗したら、schedules の DELETE もロールバックされる', async () => {
    await stores.schedules.put(PLAN);
    await stores.schedules.putPhase({
      kind: 'self_initiative',
      lastScheduledRunAt: '2026-09-01T00:00:00.000Z',
    });

    // schedule_phases の DELETE で落ちたことまで見る。ほかの理由で schedules の
    // DELETE の前に落ちても schedules は残るので、例外の中身を見ないと緑になって
    // しまう。drizzle は仕込んだ例外を `Failed query: <SQL>` で包むので、SQL の側で見る。
    await expect(stores.schedules.clear()).rejects.toThrow(
      /Failed query: delete from "schedule_phases"/,
    );

    // ロールバックされていれば、schedules の行は消えずに残っているはず。
    const remainingSchedules = await db.select().from(schedules);
    expect(remainingSchedules.map((row) => row.kind)).toEqual(['issue-round']);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { schedules } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
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
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);

  // `db.execute` / `client.query` を使わない: "cannot insert multiple commands into a prepared statement" で落ちるため、`client.exec` を使う。
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

    // 例外の中身を見る: ほかの理由で先に落ちても行は残り、緑になってしまうため。drizzle は例外を `Failed query: <SQL>` で包むので SQL の側で見る。
    await expect(stores.schedules.clear()).rejects.toThrow(
      /Failed query: delete from "schedule_phases"/,
    );

    const remainingSchedules = await db.select().from(schedules);
    expect(remainingSchedules.map((row) => row.kind)).toEqual(['issue-round']);
  });
});

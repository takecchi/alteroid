import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { migrate } from './migrate.js';
import { createEmptyTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  const handle = await createEmptyTestDb();
  client = handle.client;
  db = handle.db;
  await migrate(db);
});

afterEach(async () => {
  await client.close();
});

const insert = (id: string, type: string) =>
  db.execute(sql`
    insert into journal (id, at, type, entry)
    values (${id}, '2026-01-01T00:00:00.000Z'::timestamptz, ${type}, '{}'::jsonb)
  `);

const ids = async (): Promise<string[]> => {
  const result = await db.execute(sql`select id from journal order by id`);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
    id: string;
  }[];
  return rows.map((r) => r.id);
};

describe('退役した日誌の種別（inbox_flow・worker_wait）の行の migrate', () => {
  it('2 種別の行だけが消え、他の種別の行は残る。2周目も壊れない', async () => {
    await insert('a-inbox', 'inbox_flow');
    await insert('b-wait', 'worker_wait');
    await insert('c-exchange', 'exchange');
    await insert('d-timing', 'turn_timing');
    await insert('e-inbox', 'inbox_flow');

    await migrate(db);

    expect(await ids()).toEqual(['c-exchange', 'd-timing']);

    await migrate(db);
    expect(await ids()).toEqual(['c-exchange', 'd-timing']);
  }, 60_000);
});

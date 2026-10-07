import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb } from './index.js';
import { migrate } from './migrate.js';
import { createEmptyTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  const handle = await createEmptyTestDb();
  client = handle.client;
  db = handle.db;
  await db.execute(
    sql.raw(`create table commitments (
       id text primary key,
       at timestamptz not null,
       closed_at timestamptz,
       commitment jsonb not null
     )`),
  );
});

afterEach(async () => {
  await client.close();
});

const insertOld = (id: string, at: string, closedAt: string | null = null) =>
  db.execute(sql`
    insert into commitments (id, at, closed_at, commitment)
    values (${id}, ${at}::timestamptz, ${closedAt}::timestamptz,
            ${JSON.stringify({ id, at, origin: 'self', body: `body ${id}` })}::jsonb)
  `);

const seqs = async (): Promise<Record<string, number | null>> => {
  const result = await db.execute(sql`select id, seq from commitments order by id`);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
    id: string;
    seq: string | number | null;
  }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.seq === null ? null : Number(r.seq)]));
};

describe('台帳の seq（入れた順の列）の migrate', () => {
  it('既存の行は (at, id) の順で seq を持ち、読め、新しい行はその後ろへ入る。2周目は動かさない', async () => {
    await insertOld('z', '2026-01-01T00:00:00.000Z');
    await insertOld('y', '2026-01-01T00:00:00.000Z');
    await insertOld('x', '2026-01-02T00:00:00.000Z');
    await insertOld('w', '2025-12-31T00:00:00.000Z', '2026-02-01T00:00:00.000Z');

    await migrate(db);

    expect(await seqs()).toEqual({ w: 1, y: 2, z: 3, x: 4 });

    const stores = createPgStoresFromDb(db);
    expect((await stores.commitments.list()).entries.map((e) => e.id)).toEqual(['y', 'z', 'x']);

    await stores.commitments.open({
      id: 'a-new',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'self',
      body: '新しい',
    });
    expect((await stores.commitments.list()).entries.map((e) => e.id)).toEqual([
      'y',
      'z',
      'a-new',
      'x',
    ]);
    expect((await seqs())['a-new']).toBe(5);

    const before = await seqs();
    await migrate(db);
    expect(await seqs()).toEqual(before);
    await stores.commitments.open({
      id: 'b-new',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'self',
      body: 'さらに新しい',
    });
    expect((await seqs())['b-new']).toBe(6);
  }, 60_000);

  it('seq が null の行（列を足した後・振る前に入った行）は2周目で最後の番号が振られ、並びでは最後に来る', async () => {
    await migrate(db);
    await db.execute(sql.raw(`alter table commitments alter column seq drop default`));
    await insertOld('n1', '2026-01-01T00:00:00.000Z');
    await db.execute(
      sql.raw(
        `alter table commitments alter column seq set default nextval('commitments_seq_seq')`,
      ),
    );
    await insertOld('m1', '2026-01-01T00:00:00.000Z');
    expect(await seqs()).toEqual({ n1: null, m1: 1 });
    const stores = createPgStoresFromDb(db);
    expect((await stores.commitments.list()).entries.map((e) => e.id)).toEqual(['m1', 'n1']);

    await migrate(db);
    expect(await seqs()).toEqual({ n1: 2, m1: 1 });
  }, 60_000);
});

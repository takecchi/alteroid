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
    sql.raw(`create table inbox_events (
       id text primary key,
       event jsonb not null,
       at timestamptz not null,
       deliveries integer not null default 0
     )`),
  );
});

afterEach(async () => {
  await client.close();
});

const event = (id: string, at: string) => ({
  type: 'human_message',
  id,
  at,
  conversationId: 'c',
  text: id,
});

const insertOld = (id: string, at: string) =>
  db.execute(sql`
    insert into inbox_events (id, event, at)
    values (${id}, ${JSON.stringify(event(id, at))}::jsonb, ${at}::timestamptz)
  `);

const seqs = async (): Promise<Record<string, number | null>> => {
  const result = await db.execute(sql`select id, seq from inbox_events order by id`);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
    id: string;
    seq: string | number | null;
  }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.seq === null ? null : Number(r.seq)]));
};

describe('受信箱の seq（入れた順の列）の migrate', () => {
  it('既存の行は (at, id) の順で seq を持ち、読め、新しい行と再 put はその後ろへ入る。2周目は動かさない', async () => {
    await insertOld('z', '2026-01-01T00:00:00.000Z');
    await insertOld('y', '2026-01-01T00:00:00.000Z');
    await insertOld('x', '2026-01-02T00:00:00.000Z');
    await insertOld('w', '2025-12-31T00:00:00.000Z');

    await migrate(db);

    expect(await seqs()).toEqual({ w: 1, y: 2, z: 3, x: 4 });

    const stores = createPgStoresFromDb(db);
    expect((await stores.inbox.peekPending()).entries.map((e) => e.event.id)).toEqual([
      'w',
      'y',
      'z',
      'x',
    ]);

    const at = '2026-01-01T00:00:00.000Z';
    await stores.inbox.put(event('a-new', at) as never, at);
    expect((await seqs())['a-new']).toBe(5);
    await stores.inbox.put(event('y', at) as never, at);
    // 番号に欠けが出うる（衝突した insert の既定も nextval を使う）ので、後ろであることだけを見る。
    expect((await seqs()).y).toBeGreaterThan(5);
    expect((await stores.inbox.claimPending()).map((e) => e.event.id)).toEqual([
      'w',
      'z',
      'a-new',
      'y',
      'x',
    ]);

    const before = await seqs();
    await migrate(db);
    expect(await seqs()).toEqual(before);
  }, 60_000);

  it('seq が null の行（列を足した後・振る前に入った行）は2周目で最後の番号が振られ、並びでは最後に来る', async () => {
    await migrate(db);
    await db.execute(sql.raw(`alter table inbox_events alter column seq drop default`));
    await insertOld('n1', '2026-01-01T00:00:00.000Z');
    await db.execute(
      sql.raw(
        `alter table inbox_events alter column seq set default nextval('inbox_events_seq_seq')`,
      ),
    );
    await insertOld('m1', '2026-01-01T00:00:00.000Z');
    expect(await seqs()).toEqual({ n1: null, m1: 1 });
    const stores = createPgStoresFromDb(db);
    expect((await stores.inbox.peekPending()).entries.map((e) => e.event.id)).toEqual(['m1', 'n1']);
    expect((await stores.inbox.claimPending()).map((e) => e.event.id)).toEqual(['m1', 'n1']);

    await migrate(db);
    expect(await seqs()).toEqual({ n1: 2, m1: 1 });
  }, 60_000);
});

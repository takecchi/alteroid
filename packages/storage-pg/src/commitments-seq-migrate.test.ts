import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb } from './index.js';
import { migrate } from './migrate.js';
import { createEmptyTestDb, type TestDbHandle } from './test-db.test-support.js';

/**
 * `commitments.seq`（入れた順の列。issue #3285）を足す migrate を、**列が無かった時代の DB** へ当てる。
 * 空の DB から migrate するだけでは「既存の行へ順を振る」文が1行も踏まれない。
 */
let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  const handle = await createEmptyTestDb();
  client = handle.client;
  db = handle.db;
  // seq の列が無かった時代の台帳（migrate.ts の旧 `create table`）
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
    // 物理順は (at, id) の順と逆（z → y → x の順で入れる）。z と y は同じ at、x は新しい at。
    await insertOld('z', '2026-01-01T00:00:00.000Z');
    await insertOld('y', '2026-01-01T00:00:00.000Z');
    await insertOld('x', '2026-01-02T00:00:00.000Z');
    await insertOld('w', '2025-12-31T00:00:00.000Z', '2026-02-01T00:00:00.000Z'); // 閉じた行にも振る

    await migrate(db);

    // (at, id) 順: w(12-31) < y(01-01) < z(01-01) < x(01-02)
    expect(await seqs()).toEqual({ w: 1, y: 2, z: 3, x: 4 });

    const stores = createPgStoresFromDb(db);
    // 既存の行が読める（列を足しても jsonb の中身は変わらない）。同じ at の y, z は id 順
    expect((await stores.commitments.list()).entries.map((e) => e.id)).toEqual(['y', 'z', 'x']);

    // 新しい行は既存の行の後ろへ入る（数え始めが最大の後ろ）。同じ at なら既存の行の後ろ
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

    // 2周目（起動のたび）は何も動かさず、数え始めも巻き戻さない
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
    // 既定を外して null の行を作る（足した直後に旧版の挿入が割り込んだ形）
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

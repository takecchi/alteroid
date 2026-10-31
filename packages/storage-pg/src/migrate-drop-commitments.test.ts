import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { migrate, migrateOnBoot } from './migrate.js';
import { createEmptyTestDb, type TestDbHandle } from './test-db.test-support.js';

// 台帳のテーブル `commitments` を落とす（#5469 P7 の段4）。行の中身（未了か閉じたか）にかかわらず、在れば落とす。
// `createEmptyTestDb` を使うので、既定は PGlite、CI の real-postgres の job では実物の PostgreSQL で走る。

let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await createEmptyTestDb());
});

afterEach(async () => {
  await client.close();
});

// 段3までに入っていた台帳の表を、そのまま作る（表・連番・部分索引・マネージャー本文の一意索引）。
// 試験が自分で持つ: schema.ts の定義は段4で消えたので、旧い DB の形はここに固定する。
async function createLegacyCommitments(): Promise<void> {
  for (const statement of [
    `create table commitments (
       id text primary key,
       at timestamptz not null,
       closed_at timestamptz,
       commitment jsonb not null
     )`,
    `create index commitments_open_idx on commitments (at) where closed_at is null`,
    `alter table commitments add column seq bigint`,
    `create sequence commitments_seq_seq`,
    `alter table commitments alter column seq set default nextval('commitments_seq_seq')`,
    `create unique index commitments_open_manager_body_idx
       on commitments ((commitment->>'source'), md5(commitment->>'body'))
       where closed_at is null and commitment->>'origin' = 'manager'`,
    `insert into commitments (id, at, closed_at, commitment) values
       ('open-1', '2026-09-17T00:00:00Z', null, '{"id":"open-1","origin":"self","body":"b"}'),
       ('closed-1', '2026-09-17T00:00:00Z', '2026-09-18T00:00:00Z', '{"id":"closed-1","origin":"self","body":"b"}')`,
  ]) {
    await db.execute(sql.raw(statement));
  }
}

async function relationPresent(name: string): Promise<boolean> {
  const result = await db.execute(
    sql`select to_regclass(${`public.${name}`}) is not null as present`,
  );
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  return (rows[0] as { present?: boolean } | undefined)?.present === true;
}

describe('台帳のテーブルを落とす（#5469 P7 の段4）', () => {
  it('⭐ 未了の行が残っていても、migrate は表・連番・索引を落とす', async () => {
    await createLegacyCommitments();
    await migrate(db, () => undefined);
    expect(await relationPresent('commitments')).toBe(false);
    expect(await relationPresent('commitments_seq_seq')).toBe(false);
    expect(await relationPresent('commitments_open_manager_body_idx')).toBe(false);
  });

  it('起動の経路（migrateOnBoot）でも落とす', async () => {
    await createLegacyCommitments();
    await migrateOnBoot(db, () => undefined);
    expect(await relationPresent('commitments')).toBe(false);
  });

  it('表の無い DB でも通り、2周目でも通る（表を作り直さない）', async () => {
    await migrate(db, () => undefined);
    await migrate(db, () => undefined);
    expect(await relationPresent('commitments')).toBe(false);
    expect(await relationPresent('commitments_seq_seq')).toBe(false);
  });
});

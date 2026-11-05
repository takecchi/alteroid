import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { DEFERRED_JOURNAL_INDEXES, ensureDeferredIndex, migrate } from './migrate.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 新しい DB を移行した後のスキーマ（表・列・索引・制約・storage parameter）を、スナップショットで1文字単位に固定する。
// `STATEMENTS` の後始末（旧い主キー・索引の drop、`create table` が今の形で作るのに続く `add column if not exists` など）を
// 外す・畳む書き換えの前後で、結果のスキーマが変わらないことを確かめるための固定。
// 列の物理的な順番（`ordinal_position`）は縛らない: 畳むと順番が変わるため、`table_name, column_name` の順に並べて見る。
// 起動と同じ所まで作る: 雛形の `migrate()` に加え、起動の後に作る日誌の索引（`ensureDeferredIndex`、`concurrently`）も作る。
// スナップショットは `__snapshots__/migrate-fresh-schema-pin.test.ts.snap`。意図してスキーマを変えたときだけ更新する。

let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
});

afterEach(async () => {
  await client.close();
});

type Row = Record<string, unknown>;

async function lines(query: string): Promise<string[]> {
  const result = await client.query<Row>(query);
  return result.rows.map((row) => Object.values(row).map(String).join(' | '));
}

async function bootIndexes(): Promise<void> {
  for (const spec of DEFERRED_JOURNAL_INDEXES) {
    await ensureDeferredIndex(db, spec.name);
  }
}

interface SchemaPin {
  tables: string[];
  columns: string[];
  indexes: string[];
  constraints: string[];
  storageParameters: string[];
}

async function captureSchema(): Promise<SchemaPin> {
  return {
    tables: await lines(
      `select table_name, table_type from information_schema.tables
        where table_schema = current_schema()
        order by table_name collate "C"`,
    ),
    columns: await lines(
      `select table_name, column_name, data_type, udt_name, is_nullable, column_default,
              character_maximum_length, numeric_precision, numeric_scale, datetime_precision,
              is_identity, is_generated, generation_expression
         from information_schema.columns
        where table_schema = current_schema()
        order by table_name collate "C", column_name collate "C"`,
    ),
    indexes: await lines(
      `select tablename, indexname, indexdef from pg_indexes
        where schemaname = current_schema()
        order by tablename collate "C", indexname collate "C"`,
    ),
    // 並びは `collate "C"` で決める: DB の照合順序（en_US.UTF-8 など）で `_` の扱いが変わり、行の順が入れ替わるため。
    // NOT NULL の制約（`contype = 'n'`）は除く: PGlite（PostgreSQL 18 系）は `pg_constraint` に出すが、CI の本物の PostgreSQL は出さない。
    // NULL の可否は `columns` の `is_nullable` が縛る。
    constraints: await lines(
      `select conrelid::regclass::text as table_name, conname, contype, pg_get_constraintdef(oid)
         from pg_constraint
        where connamespace = current_schema()::regnamespace and contype <> 'n'
        order by conrelid::regclass::text collate "C", conname collate "C"`,
    ),
    // 表と、その TOAST 表（`toast.autovacuum_*`）の reloptions
    storageParameters: await lines(
      `select c.relname, coalesce(c.reloptions::text, '-') as options,
              coalesce(t.reloptions::text, '-') as toast_options
         from pg_class c left join pg_class t on t.oid = c.reltoastrelid
        where c.relnamespace = current_schema()::regnamespace and c.relkind = 'r'
        order by c.relname collate "C"`,
    ),
  };
}

describe('新しい DB を移行した後のスキーマ', () => {
  it('表・列・索引・制約・storage parameter がスナップショットのとおりで、移行を2回打っても変わらない', async () => {
    await bootIndexes();
    const first = await captureSchema();

    expect(first.tables).toMatchSnapshot('tables');
    expect(first.columns).toMatchSnapshot('columns');
    expect(first.indexes).toMatchSnapshot('indexes');
    expect(first.constraints).toMatchSnapshot('constraints');
    expect(first.storageParameters).toMatchSnapshot('storage parameters');

    await migrate(db);
    await bootIndexes();
    expect(await captureSchema()).toEqual(first);

    await migrate(db);
    await bootIndexes();
    expect(await captureSchema()).toEqual(first);
  }, 60_000);
});

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { migratedTemplate } from './pglite-template.test-support.js';
import {
  createMigratedTestDb,
  realPostgresCollation,
  realPostgresUrl,
  type TestDbHandle,
} from './test-db.test-support.js';

/**
 * `test-db.test-support.ts` の歯（#2918）。**本物の PostgreSQL へ向けたときだけ
 * 走る**（`ALTEROID_TEST_PG_URL` が無ければ `skipIf` で止める。PGlite の側は
 * `pglite-template.test.ts` が測っている）。
 *
 * 測るのは「本物へ繋いだつもり」で終わらないこと:
 * - 本当に PGlite ではなく、期待した照合順の PostgreSQL に繋がっている
 *   （`ALTEROID_TEST_PG_EXPECT_COLLATE` を CI が渡す。照合順の違いが出る
 *   `'a' < 'B'` の真偽でも確かめる — C は偽、en_US は真）
 * - 複製は migrate 済みで、互いに独立している
 */
const real = realPostgresUrl() !== undefined;
const opened: TestDbHandle[] = [];

// PGlite の側（本物を向けないとき）の雛形作りの費用は、歯の本体ではなくここで払う。
beforeAll(async () => {
  if (!real) await migratedTemplate();
}, 30_000);

afterEach(async () => {
  await Promise.all(opened.splice(0).map((client) => client.close()));
});

async function open(): Promise<TestDbHandle> {
  const { client } = await createMigratedTestDb();
  opened.push(client);
  return client;
}

describe.skipIf(!real)('createMigratedTestDb（本物の PostgreSQL）', () => {
  it('PGlite ではなく本物の PostgreSQL へ繋がっていて、照合順が期待どおり', async () => {
    const client = await open();
    const info = await client.query(
      `select version() as version, datcollate from pg_database where datname = current_database()`,
    );
    const row = info.rows[0] as { version: string; datcollate: string };
    // PGlite の version() は "... on x86_64-pc-linux-gnu, compiled by emscripten" になる。
    expect(row.version).not.toContain('emscripten');

    const configured = await realPostgresCollation(realPostgresUrl()!);
    expect(row.datcollate).toBe(configured);

    const expected = process.env.ALTEROID_TEST_PG_EXPECT_COLLATE;
    if (expected !== undefined && expected !== '') {
      expect(row.datcollate).toBe(expected);
      const cmp = await client.query(`select ('a' < 'B') as lt`);
      // 'a'(97) と 'B'(66): C はバイト順で偽、en_US は大文字小文字を同じ綴りとして見るので真。
      expect((cmp.rows[0] as { lt: boolean }).lt).toBe(!expected.startsWith('C'));
    }
  });

  it('migrate 済みで、片方への書き込みはもう片方に見えない', async () => {
    const a = await open();
    const b = await open();
    const count = async (client: TestDbHandle): Promise<number> => {
      const result = await client.query('select count(*)::int as n from usage_daily');
      return (result.rows[0] as { n: number }).n;
    };
    expect(await count(a)).toBe(0);
    await a.query(
      `insert into usage_daily (date, manager_id, model, input_tokens, output_tokens, updated_at) values ('2026-01-01', 'm1', 'm', 1, 1, now())`,
    );
    expect(await count(a)).toBe(1);
    expect(await count(b)).toBe(0);
  });
});

describe.skipIf(real)('createMigratedTestDb（ALTEROID_TEST_PG_URL が無いとき）', () => {
  it('従来どおり PGlite へ落ちる（手元と既存の CI は何も変わらない）', async () => {
    const client = await open();
    const result = await client.query('select count(*)::int as n from usage_daily');
    expect((result.rows[0] as { n: number }).n).toBe(0);
    const version = await client.query('select version() as version');
    expect((version.rows[0] as { version: string }).version).toContain('emscripten');
  });
});

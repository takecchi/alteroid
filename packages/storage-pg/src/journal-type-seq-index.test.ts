import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb } from './index.js';
import { ensureJournalTypeSeqIndex, JOURNAL_TYPE_SEQ_INDEX } from './migrate.js';
import { journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 種別と `seq` の索引（#5264。`GET /reports`・`GET /progress` が薄い種別を読むのに日誌の大半を辿っていた件）

let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
});

afterEach(async () => {
  await client.close();
});

async function indexState(): Promise<{ valid: boolean } | undefined> {
  const result = await client.query<{ valid: boolean }>(
    `select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = '${JOURNAL_TYPE_SEQ_INDEX}'`,
  );
  return result.rows[0];
}

const BASE = Date.parse('2026-10-01T00:00:00.000Z');

describe('ensureJournalTypeSeqIndex', () => {
  it('⭐ 索引を作り、二度目は何もしない（警告も出さない）', async () => {
    const warnings: string[] = [];
    await ensureJournalTypeSeqIndex(db, (line) => warnings.push(line));
    expect(await indexState()).toEqual({ valid: true });
    await ensureJournalTypeSeqIndex(db, (line) => warnings.push(line));
    expect(await indexState()).toEqual({ valid: true });
    expect(warnings).toEqual([]);
  });

  it('⭐ 種別で絞った頁（日報の一覧が打つ listPage）の SQL の計画が、この索引に乗る', async () => {
    await ensureJournalTypeSeqIndex(db, () => undefined);
    // 日報を 1% だけ混ぜる（本番の日報は日誌のごく一部）
    const rows = Array.from({ length: 3000 }, (_, i) =>
      i % 100 === 0
        ? {
            id: `row-${String(i)}`,
            at: new Date(BASE + i * 1000),
            type: 'daily_report',
            entry: {
              date: new Date(BASE + i * 86_400_000).toISOString().slice(0, 10),
              body: `日報 ${String(i)}`,
            },
          }
        : {
            id: `row-${String(i)}`,
            at: new Date(BASE + i * 1000),
            type: 'tool_use',
            entry: { actor: 'clone', tool: 'Read', input: {} },
          },
    );
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(journal).values(rows.slice(i, i + 500));
    }
    await client.exec('analyze journal');

    const queries: { sql: string; params: unknown[] }[] = [];
    const logged = createPgStoresFromDb(
      client.withLogger({
        logQuery: (text, params) => {
          queries.push({ sql: text, params });
        },
      }),
    );
    await logged.journal.listPage({ types: ['daily_report'], limit: 33 });

    const query = queries.find(
      (entry) =>
        entry.sql.includes('order by') && entry.params.some((param) => param === 'daily_report'),
    );
    if (query === undefined) throw new Error('種別で絞った頁の SQL を捕まえられなかった');
    const inlined = query.sql.replace(/\$(\d+)/g, (_match, index: string) => {
      const value = query.params[Number(index) - 1];
      if (Array.isArray(value)) return `'{${value.map((item) => JSON.stringify(item)).join(',')}}'`;
      return typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
    });
    // 順の走査を禁じて計画を取る: 測りたいのは「索引の鍵が頁の絞りと並びに合っているか」で、3,000 行の表では順に読む方が安いと見積もられ、合っていても索引が選ばれないため
    await client.exec('set enable_seqscan = off');
    const plan = (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${inlined}`)).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    // 名前が出るだけでは足りない: 鍵が並びに合わない索引（`type`, `at`）でも、索引で拾ってから並べ替える計画に名前が出るため。
    // 並べ替えずに新しい側から辿って `limit` で止まる形（`Index Scan Backward`）であることまで見る
    expect(plan).toContain(`Index Scan Backward using ${JOURNAL_TYPE_SEQ_INDEX}`);
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it('作りかけで無効になった索引は、消して作り直す', async () => {
    await ensureJournalTypeSeqIndex(db, () => undefined);
    await client.exec(
      `update pg_index set indisvalid = false where indexrelid = '${JOURNAL_TYPE_SEQ_INDEX}'::regclass`,
    );
    expect(await indexState()).toEqual({ valid: false });
    await ensureJournalTypeSeqIndex(db, () => undefined);
    expect(await indexState()).toEqual({ valid: true });
  });

  it('作れなくても投げず、警告を1行出す', async () => {
    const warnings: string[] = [];
    const broken = {
      execute: () => Promise.reject(new Error('接続が切れた')),
    } as unknown as Db;
    await expect(ensureJournalTypeSeqIndex(broken, (line) => warnings.push(line))).resolves.toBe(
      undefined,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(JOURNAL_TYPE_SEQ_INDEX);
  });
});

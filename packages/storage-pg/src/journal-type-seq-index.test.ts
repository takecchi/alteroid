import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb } from './index.js';
import { ensureJournalTypeSeqIndex, JOURNAL_TYPE_SEQ_INDEX } from './migrate.js';
import { journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 種別で絞った日誌を seq の順に頁で読むための索引

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

  it('⭐ 種別で絞った頁送り（listPage）が実際に打つ SQL の計画がこの索引に乗る', async () => {
    await ensureJournalTypeSeqIndex(db, () => undefined);
    const rows = Array.from({ length: 3000 }, (_, i) => ({
      id: `row-${String(i)}`,
      at: new Date(BASE + i * 1000),
      type: i % 100 === 0 ? 'memory_update' : 'tool_use',
      entry: { note: `行 ${String(i)}` },
    }));
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
    await logged.journal.listPage({ types: ['memory_update'], order: 'asc', limit: 10 });
    // 最後の1本を取らない: 問い合わせはトランザクションに包まれ、最後は `commit` になりうるため
    const query = queries.findLast((entry) => /order by/i.test(entry.sql));
    if (query === undefined) throw new Error('SQL を捕まえられなかった');
    const inlined = query.sql.replace(/\$(\d+)/g, (_match, index: string) => {
      const value = query.params[Number(index) - 1];
      return typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
    });
    // 順の走査を禁じて計画を取る: 測りたいのは「索引が頁送りの形（type の絞りと seq の順）に合っているか」で、3,000 行の表では順に読む方が安いと見積もられるため
    await client.exec('set enable_seqscan = off');
    const plan = (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${inlined}`)).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    expect(plan).toContain(JOURNAL_TYPE_SEQ_INDEX);
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
    await expect(
      ensureJournalTypeSeqIndex(broken, (line) => warnings.push(line)),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(JOURNAL_TYPE_SEQ_INDEX);
  });
});

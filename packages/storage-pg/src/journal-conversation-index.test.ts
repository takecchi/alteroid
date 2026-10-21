import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb } from './index.js';
import { ensureJournalConversationSeqIndex, JOURNAL_CONVERSATION_SEQ_INDEX } from './migrate.js';
import { journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 会話を名指した日誌の読み（`JournalQuery.conversationId`）の部分索引

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
    `select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = '${JOURNAL_CONVERSATION_SEQ_INDEX}'`,
  );
  return result.rows[0];
}

const BASE = Date.parse('2026-10-01T00:00:00.000Z');

describe('ensureJournalConversationSeqIndex', () => {
  it('⭐ 索引を作り、二度目は何もしない（警告も出さない）', async () => {
    const warnings: string[] = [];
    await ensureJournalConversationSeqIndex(db, (line) => warnings.push(line));
    expect(await indexState()).toEqual({ valid: true });
    await ensureJournalConversationSeqIndex(db, (line) => warnings.push(line));
    expect(await indexState()).toEqual({ valid: true });
    expect(warnings).toEqual([]);
  });

  it('⭐ 会話を名指した読み（listPage の conversationId）が実際に打つ SQL の計画がこの索引に乗る（述語がずれていない）', async () => {
    await ensureJournalConversationSeqIndex(db, () => undefined);
    const rows = Array.from({ length: 3000 }, (_, i) => ({
      id: `row-${String(i)}`,
      at: new Date(BASE + i * 1000),
      type: 'exchange',
      entry: {
        with: 'human',
        role: 'inbound',
        text: `発言 ${String(i)}`,
        conversationId: `conv-${String(i % 50)}`,
      },
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
    const page = await logged.journal.listPage({
      types: ['exchange'],
      with: ['human'],
      conversationId: 'conv-3',
      limit: 10,
    });
    expect(page.entries).toHaveLength(10);
    // 最後の1本を取らない: 問い合わせはトランザクションに包まれ、最後は `commit` になりうるため
    const query = queries.findLast((entry) => entry.sql.includes(`'conversationId'`));
    if (query === undefined) throw new Error('SQL を捕まえられなかった');
    const inlined = query.sql.replace(/\$(\d+)/g, (_match, index: string) => {
      const value = query.params[Number(index) - 1];
      if (Array.isArray(value)) return `'{${value.map((item) => JSON.stringify(item)).join(',')}}'`;
      return typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
    });
    // 順の走査を禁じて計画を取る: 測りたいのは「索引の述語が読み出しの絞りとずれていないか」で、3,000 行の表では順に読む方が安いと見積もられうるため
    await client.exec('set enable_seqscan = off');
    const plan = (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${inlined}`)).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    expect(plan).toContain(JOURNAL_CONVERSATION_SEQ_INDEX);
  });

  it('作りかけで無効になった索引は、消して作り直す', async () => {
    await ensureJournalConversationSeqIndex(db, () => undefined);
    await client.exec(
      `update pg_index set indisvalid = false where indexrelid = '${JOURNAL_CONVERSATION_SEQ_INDEX}'::regclass`,
    );
    expect(await indexState()).toEqual({ valid: false });
    await ensureJournalConversationSeqIndex(db, () => undefined);
    expect(await indexState()).toEqual({ valid: true });
  });

  it('作れなくても投げず、警告を1行出す', async () => {
    const warnings: string[] = [];
    const broken = {
      execute: () => Promise.reject(new Error('接続が切れた')),
    } as unknown as Db;
    await expect(
      ensureJournalConversationSeqIndex(broken, (line) => warnings.push(line)),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(JOURNAL_CONVERSATION_SEQ_INDEX);
  });
});

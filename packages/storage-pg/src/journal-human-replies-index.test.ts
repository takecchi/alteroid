import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb } from './index.js';
import { ensureJournalHumanRepliesIndex, JOURNAL_HUMAN_REPLIES_INDEX } from './migrate.js';
import { journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 人間への返答の部分索引（#5089）を、書き込みを止めずに作る

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
    `select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = '${JOURNAL_HUMAN_REPLIES_INDEX}'`,
  );
  return result.rows[0];
}

describe('ensureJournalHumanRepliesIndex（#5089）', () => {
  it('⭐ 索引を作り、二度目は何もしない（警告も出さない）', async () => {
    const warnings: string[] = [];
    await ensureJournalHumanRepliesIndex(db, (line) => warnings.push(line));
    expect(await indexState()).toEqual({ valid: true });
    await ensureJournalHumanRepliesIndex(db, (line) => warnings.push(line));
    expect(await indexState()).toEqual({ valid: true });
    expect(warnings).toEqual([]);
  });

  it('⭐ 返答の読み出し（humanReplies）が実際に打つ SQL の計画がこの索引に乗る（述語がずれていない）', async () => {
    await ensureJournalHumanRepliesIndex(db, () => undefined);
    const rows = Array.from({ length: 3000 }, (_, i) => ({
      id: `row-${String(i)}`,
      at: new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 1000),
      type: i % 30 === 0 ? 'exchange' : 'tool_use',
      entry:
        i % 30 === 0
          ? {
              with: 'human',
              role: 'outbound',
              text: '返答',
              conversationId: `conv-${String(i % 7)}`,
            }
          : { actor: 'clone', tool: 'Read', input: {} },
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
    const replies = await logged.journal.humanReplies?.();
    expect(replies).toHaveLength(100);
    const query = queries.at(-1);
    if (query === undefined) throw new Error('SQL を捕まえられなかった');
    const inlined = query.sql.replace(/\$(\d+)/g, (_match, index: string) => {
      const value = query.params[Number(index) - 1];
      return typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
    });
    const plan = (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${inlined}`)).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    expect(plan).toContain(JOURNAL_HUMAN_REPLIES_INDEX);
  });

  it('作りかけで無効になった索引は、消して作り直す', async () => {
    await ensureJournalHumanRepliesIndex(db, () => undefined);
    await client.exec(
      `update pg_index set indisvalid = false where indexrelid = '${JOURNAL_HUMAN_REPLIES_INDEX}'::regclass`,
    );
    expect(await indexState()).toEqual({ valid: false });
    await ensureJournalHumanRepliesIndex(db, () => undefined);
    expect(await indexState()).toEqual({ valid: true });
  });

  it('作れなくても投げず、警告を1行出す', async () => {
    const warnings: string[] = [];
    const broken = {
      execute: () => Promise.reject(new Error('接続が切れた')),
    } as unknown as Db;
    await expect(
      ensureJournalHumanRepliesIndex(broken, (line) => warnings.push(line)),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(JOURNAL_HUMAN_REPLIES_INDEX);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb } from './index.js';
import { ensureJournalWithdrawalsIndex, JOURNAL_WITHDRAWALS_INDEX } from './migrate.js';
import { journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 取り下げの印の部分索引と、印だけを引く口（#5089）

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
    `select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = '${JOURNAL_WITHDRAWALS_INDEX}'`,
  );
  return result.rows[0];
}

const BASE = Date.parse('2026-10-01T00:00:00.000Z');

describe('ensureJournalWithdrawalsIndex（#5089）', () => {
  it('⭐ 索引を作り、二度目は何もしない（警告も出さない）', async () => {
    const warnings: string[] = [];
    await ensureJournalWithdrawalsIndex(db, (line) => warnings.push(line));
    expect(await indexState()).toEqual({ valid: true });
    await ensureJournalWithdrawalsIndex(db, (line) => warnings.push(line));
    expect(await indexState()).toEqual({ valid: true });
    expect(warnings).toEqual([]);
  });

  it('⭐ 印の読み出し（withdrawnClientMessageIds）が実際に打つ SQL の計画がこの索引に乗る（述語がずれていない）', async () => {
    await ensureJournalWithdrawalsIndex(db, () => undefined);
    const rows = Array.from({ length: 3000 }, (_, i) => ({
      id: `row-${String(i)}`,
      at: new Date(BASE + i * 1000),
      type: 'exchange',
      entry:
        i % 300 === 0
          ? {
              with: 'self',
              role: 'outbound',
              text: '取り下げた',
              conversationId: `conv-${String(i % 7)}`,
              withdrawnClientMessageId: `cm-${String(i)}`,
            }
          : { with: 'self', role: 'outbound', text: '内部ターン', conversationId: 'conv-0' },
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
    const ids = await logged.journal.withdrawnClientMessageIds?.({
      since: new Date(BASE).toISOString(),
    });
    expect([...(ids ?? [])].sort()).toEqual(
      Array.from({ length: 10 }, (_, k) => `cm-${String(k * 300)}`).sort(),
    );
    const query = queries.at(-1);
    if (query === undefined) throw new Error('SQL を捕まえられなかった');
    const inlined = query.sql.replace(/\$(\d+)/g, (_match, index: string) => {
      const value = query.params[Number(index) - 1];
      return typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
    });
    // 順の走査を禁じて計画を取る: 測りたいのは「索引の述語が読み出しの絞りとずれていないか」で、3,000 行の表では順に読む方が安いと見積もられ、述語が合っていても索引が選ばれないため
    await client.exec('set enable_seqscan = off');
    const plan = (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${inlined}`)).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    expect(plan).toContain(JOURNAL_WITHDRAWALS_INDEX);
  });

  it('作りかけで無効になった索引は、消して作り直す', async () => {
    await ensureJournalWithdrawalsIndex(db, () => undefined);
    await client.exec(
      `update pg_index set indisvalid = false where indexrelid = '${JOURNAL_WITHDRAWALS_INDEX}'::regclass`,
    );
    expect(await indexState()).toEqual({ valid: false });
    await ensureJournalWithdrawalsIndex(db, () => undefined);
    expect(await indexState()).toEqual({ valid: true });
  });

  it('作れなくても投げず、警告を1行出す', async () => {
    const warnings: string[] = [];
    const broken = {
      execute: () => Promise.reject(new Error('接続が切れた')),
    } as unknown as Db;
    await expect(
      ensureJournalWithdrawalsIndex(broken, (line) => warnings.push(line)),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(JOURNAL_WITHDRAWALS_INDEX);
  });
});

describe('PgJournalStore.withdrawnClientMessageIds（#5089）', () => {
  it('削除した会話の印は、list と同じく外す', async () => {
    const stores = createPgStoresFromDb(db);
    await stores.journal.append({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: '取り下げた',
      conversationId: 'conv-kept',
      withdrawnClientMessageId: 'cm-kept',
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: '取り下げた',
      conversationId: 'conv-gone',
      withdrawnClientMessageId: 'cm-gone',
    });
    await stores.journal.append({
      type: 'conversation_deleted',
      deletedConversationId: 'conv-gone',
      deletedBy: 'operator',
      hiddenCount: 1,
    });

    const ids = await stores.journal.withdrawnClientMessageIds?.({
      since: '1970-01-01T00:00:00.000Z',
    });

    expect(ids).toEqual(['cm-kept']);
  });

  it('印の欄が文字列でない行は数えない（list が読み出しで落とす形と揃える）', async () => {
    await db.insert(journal).values({
      id: 'row-bad',
      at: new Date(BASE),
      type: 'exchange',
      entry: { with: 'self', role: 'outbound', text: 'x', withdrawnClientMessageId: 42 },
    });
    const stores = createPgStoresFromDb(db);

    const ids = await stores.journal.withdrawnClientMessageIds?.({
      since: '1970-01-01T00:00:00.000Z',
    });

    expect(ids).toEqual([]);
  });
});

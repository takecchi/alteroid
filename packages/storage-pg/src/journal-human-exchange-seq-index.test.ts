import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readConversationPage } from '@alteroid/core';

import type { Db } from './db.js';
import { createPgStoresFromDb } from './index.js';
import { ensureJournalHumanExchangeSeqIndex, JOURNAL_HUMAN_EXCHANGE_SEQ_INDEX } from './migrate.js';
import { journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 人間との往復の部分索引（会話の一覧 `GET /conversations` が 9 秒かかった件）

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
    `select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = '${JOURNAL_HUMAN_EXCHANGE_SEQ_INDEX}'`,
  );
  return result.rows[0];
}

const BASE = Date.parse('2026-10-01T00:00:00.000Z');

describe('ensureJournalHumanExchangeSeqIndex', () => {
  it('⭐ 索引を作り、二度目は何もしない（警告も出さない）', async () => {
    const warnings: string[] = [];
    await ensureJournalHumanExchangeSeqIndex(db, (line) => warnings.push(line));
    expect(await indexState()).toEqual({ valid: true });
    await ensureJournalHumanExchangeSeqIndex(db, (line) => warnings.push(line));
    expect(await indexState()).toEqual({ valid: true });
    expect(warnings).toEqual([]);
  });

  it('⭐ 会話の一覧（readConversationPage）が実際に打つ窓の SQL の計画が、この索引に乗る（述語がずれていない）', async () => {
    await ensureJournalHumanExchangeSeqIndex(db, () => undefined);
    // 人間との往復を 1% だけ混ぜる（本番に近い薄さ）
    const rows = Array.from({ length: 3000 }, (_, i) =>
      i % 100 === 0
        ? {
            id: `row-${String(i)}`,
            at: new Date(BASE + i * 1000),
            type: 'exchange',
            entry: {
              with: 'human',
              role: i % 200 === 0 ? 'inbound' : 'outbound',
              text: `発言 ${String(i)}`,
              conversationId: `conv-${String(i % 7)}`,
            },
          }
        : {
            id: `row-${String(i)}`,
            at: new Date(BASE + i * 1000),
            type: 'exchange',
            entry: { with: 'manager', role: 'inbound', text: 'マネージャーとの往復' },
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
    const page = await readConversationPage(logged.journal, { limit: 30, scan: 2000 });
    // 読み出しの答えは索引の有無で変わらない（30 件の人間との往復が7会話に分かれる）
    expect(page.scanned).toBe(30);
    expect(page.conversations).toHaveLength(7);

    const query = queries.find(
      (entry) => entry.sql.includes(`"journal"."entry"->>'with'`) && entry.sql.includes('order by'),
    );
    if (query === undefined) throw new Error('窓の SQL を捕まえられなかった');
    const inlined = query.sql.replace(/\$(\d+)/g, (_match, index: string) => {
      const value = query.params[Number(index) - 1];
      if (Array.isArray(value)) return `'{${value.map((item) => JSON.stringify(item)).join(',')}}'`;
      return typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
    });
    // 順の走査を禁じて計画を取る: 測りたいのは「索引の述語が窓の絞りとずれていないか」で、3,000 行の表では順に読む方が安いと見積もられ、述語が合っていても索引が選ばれないため
    await client.exec('set enable_seqscan = off');
    const plan = (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${inlined}`)).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    expect(plan).toContain(JOURNAL_HUMAN_EXCHANGE_SEQ_INDEX);
  });

  it('作りかけで無効になった索引は、消して作り直す', async () => {
    await ensureJournalHumanExchangeSeqIndex(db, () => undefined);
    await client.exec(
      `update pg_index set indisvalid = false where indexrelid = '${JOURNAL_HUMAN_EXCHANGE_SEQ_INDEX}'::regclass`,
    );
    expect(await indexState()).toEqual({ valid: false });
    await ensureJournalHumanExchangeSeqIndex(db, () => undefined);
    expect(await indexState()).toEqual({ valid: true });
  });

  it('作れなくても投げず、警告を1行出す', async () => {
    const warnings: string[] = [];
    const broken = {
      execute: () => Promise.reject(new Error('接続が切れた')),
    } as unknown as Db;
    await expect(
      ensureJournalHumanExchangeSeqIndex(broken, (line) => warnings.push(line)),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(JOURNAL_HUMAN_EXCHANGE_SEQ_INDEX);
  });
});

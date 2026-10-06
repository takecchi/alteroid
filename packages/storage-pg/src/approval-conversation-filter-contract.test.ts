import { verifyApprovalConversationFilterContract } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  const made = await createMigratedTestDb();
  client = made.client;
  db = made.db;
  stores = createPgStoresFromDb(made.db);
});

afterEach(async () => {
  await client.close();
});

describe('承認の会話の絞りの契約（#3290）— pg', () => {
  it('会話の絞りが、絞らない結果を一致で絞ったものと同じ', async () => {
    await verifyApprovalConversationFilterContract(stores);
  });

  it('式索引 approvals_conversation_id_idx が在り、2周目の migrate でも落ちない', async () => {
    const result = await db.execute(
      sql`select indexdef from pg_indexes where indexname = 'approvals_conversation_id_idx'`,
    );
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      indexdef: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("(approval ->> 'conversationId'::text)");
  });

  it('会話の絞りは SQL に渡り、一致しない行は entries に載らない（絞りの式が索引の式と同じ）', async () => {
    for (let i = 0; i < 20; i += 1) {
      await stores.jobs.putApproval({
        id: `ap-${i}`,
        createdAt: new Date(Date.UTC(2026, 2, 1, 0, 0, i)).toISOString(),
        question: 'q',
        conversationId: i % 10 === 0 ? 'conv-target' : `conv-${i}`,
      });
    }
    // 索引が使われうる式であること: seq scan を禁じても、同じ式の問い合わせが通る。
    await db.execute(sql`set enable_seqscan = off`);
    const plan = await db.execute(
      sql`explain select id from approvals where (approval->>'conversationId') = 'conv-target'`,
    );
    const text = JSON.stringify(plan);
    expect(text).toContain('approvals_conversation_id_idx');
    const list = await stores.jobs.listApprovals({ conversationId: 'conv-target' });
    expect(list.entries.map((e) => e.id)).toEqual(['ap-0', 'ap-10']);
  });
});

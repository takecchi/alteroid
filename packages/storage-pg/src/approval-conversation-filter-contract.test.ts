import { captureStderr, verifyApprovalConversationFilterContract } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { createPgStoresFromDb, tables, type PgStores } from './index.js';
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

  describe('読めない行（#3319）', () => {
    async function seedBad(): Promise<void> {
      const bad = (id: string, extra: Record<string, unknown>, settled = false) =>
        db.insert(tables.approvals).values({
          id,
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          answeredAt: settled ? new Date('2026-03-02T00:00:00.000Z') : null,
          withdrawnAt: null,
          approval: { id, createdAt: 'not-a-date', question: 'x', ...extra },
        });
      await bad('bad-x', { conversationId: 'conv-x' });
      await bad('bad-x-settled', { conversationId: 'conv-x' }, true);
      await bad('bad-y', { conversationId: 'conv-y' });
      await bad('bad-none', {});
      await bad('bad-num', { conversationId: 5 });
    }

    it('会話で絞った unreadable は、生の conversationId が一致する行だけ。絞らない呼びは全件', async () => {
      await seedBad();
      await captureStderr(async () => {
        const ids = async (o: { pendingOnly?: boolean; conversationId?: string }) =>
          (await stores.jobs.listApprovals(o)).unreadable.map((u) => u.id).sort();
        expect(await ids({ conversationId: 'conv-x' })).toEqual(['bad-x', 'bad-x-settled']);
        expect(await ids({ conversationId: 'conv-x', pendingOnly: true })).toEqual(['bad-x']);
        expect(await ids({ conversationId: 'conv-y' })).toEqual(['bad-y']);
        expect(await ids({ conversationId: 'conv-none' })).toEqual([]);
        expect(await ids({ conversationId: 'conv-x\u0000' })).toEqual([]);
        expect(await ids({})).toEqual(['bad-none', 'bad-num', 'bad-x', 'bad-x-settled', 'bad-y']);
      });
    });

    it('一致しない行は読まない（スキーマに通さない。stderr に跡が出ない）', async () => {
      await seedBad();
      const trace = await captureStderr(async () => {
        await stores.jobs.listApprovals({ conversationId: 'conv-x' });
      });
      expect(trace.join('')).toContain('bad-x');
      for (const other of ['bad-y', 'bad-none', 'bad-num']) {
        expect(trace.join('')).not.toContain(other);
      }
    });

    it('実際の絞りの文（pendingOnly つき）が索引を使い、全行を走査しない', async () => {
      for (let i = 0; i < 30; i += 1) {
        await stores.jobs.putApproval({
          id: `ap-${i}`,
          createdAt: new Date(Date.UTC(2026, 2, 1, 0, 0, i)).toISOString(),
          question: 'q',
          conversationId: `conv-${i}`,
        });
      }
      await db.execute(sql`set enable_seqscan = off`);
      const plan = await db.execute(
        sql`explain select id, approval from approvals
          where answered_at is null and withdrawn_at is null
            and (approval->>'conversationId') = 'conv-3' order by created_at`,
      );
      const text = JSON.stringify(plan);
      expect(text).toContain('approvals_conversation_id_idx');
      expect(text).not.toContain('Seq Scan');
    });
  });
});

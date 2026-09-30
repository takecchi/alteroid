import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

/**
 * `pglite-template.test-support.ts` の歯。複製が雛形（と他の複製）から独立している
 * こと・migrate 済みであること・雛形が1回しか作られないことを測る。
 * 複製の分離が壊れると、移した側の全テストが「前のテストの行」を見て静かに壊れる。
 */
describe('createMigratedPglite', () => {
  it('migrate 済みで、行は1つも無い状態から始まる', async () => {
    const { client, db } = await createMigratedPglite();
    try {
      const tables = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'usage_daily'`,
      );
      expect(tables.rows[0]?.n).toBe(1);
      const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from usage_daily`);
      expect(rows.rows[0]?.n).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('片方の複製への書き込みは、もう片方の複製にも、あとから作る複製にも見えない', async () => {
    const a = await createMigratedPglite();
    const b = await createMigratedPglite();
    try {
      await a.db.execute(
        sql`insert into usage_daily (date, manager_id, model, cost_usd, updated_at)
            values ('2026-08-01', 'mgr-a', 'claude-opus-5', 1, '2026-08-01T00:00:00Z')`,
      );
      const seenByA = await a.db.execute<{ n: number }>(
        sql`select count(*)::int as n from usage_daily`,
      );
      const seenByB = await b.db.execute<{ n: number }>(
        sql`select count(*)::int as n from usage_daily`,
      );
      expect(seenByA.rows[0]?.n).toBe(1);
      expect(seenByB.rows[0]?.n).toBe(0);

      const c = await createMigratedPglite();
      try {
        const seenByC = await c.db.execute<{ n: number }>(
          sql`select count(*)::int as n from usage_daily`,
        );
        expect(seenByC.rows[0]?.n).toBe(0);
      } finally {
        await c.client.close();
      }
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  it('複製を閉じても、雛形は使い続けられる（次の複製も空で起きる）', async () => {
    const first = await createMigratedPglite();
    await first.client.close();
    const second = await createMigratedPglite();
    try {
      const rows = await second.db.execute<{ n: number }>(
        sql`select count(*)::int as n from usage_daily`,
      );
      expect(rows.rows[0]?.n).toBe(0);
    } finally {
      await second.client.close();
    }
  });

  it('雛形はワーカーの中で1回しか作らない（同じ Promise を返す）', () => {
    expect(migratedTemplate()).toBe(migratedTemplate());
  });
});

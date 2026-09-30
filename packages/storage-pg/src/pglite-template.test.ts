import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

/**
 * `pglite-template.test-support.ts` の歯。複製が雛形（と他の複製）から独立している
 * こと・migrate 済みであること・雛形が1回しか作られないことを測る。
 * 複製の分離が壊れると、移した側の全テストが「前のテストの行」を見て静かに壊れる。
 */
async function countUsageRows(client: PGlite): Promise<number> {
  const result = await client.query<{ n: number }>('select count(*)::int as n from usage_daily');
  return result.rows[0]?.n ?? -1;
}

describe('createMigratedPglite', () => {
  // 雛形（WASM の起動＋migrate）は最初に呼んだ歯が払う。歯の本体（既定 5000ms）でなく
  // hook（明示 30_000ms）で払わせる（issue #2337）。「1回しか作らない」の歯は別に測る。
  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  it('migrate 済みで、行は1つも無い状態から始まる', async () => {
    const { client } = await createMigratedPglite();
    try {
      const tables = await client.query<{ n: number }>(
        `select count(*)::int as n from information_schema.tables
         where table_schema = 'public' and table_name = 'usage_daily'`,
      );
      expect(tables.rows[0]?.n).toBe(1);
      expect(await countUsageRows(client)).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('片方の複製への書き込みは、もう片方の複製にも、あとから作る複製にも見えない', async () => {
    const a = await createMigratedPglite();
    const b = await createMigratedPglite();
    try {
      await a.client.exec(
        `insert into usage_daily (date, manager_id, model, cost_usd, updated_at)
         values ('2026-08-01', 'mgr-a', 'claude-opus-5', 1, '2026-08-01T00:00:00Z')`,
      );
      expect(await countUsageRows(a.client)).toBe(1);
      expect(await countUsageRows(b.client)).toBe(0);

      const c = await createMigratedPglite();
      try {
        expect(await countUsageRows(c.client)).toBe(0);
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
      expect(await countUsageRows(second.client)).toBe(0);
    } finally {
      await second.client.close();
    }
  });

  it('雛形はワーカーの中で1回しか作らない（同じ Promise を返す）', () => {
    expect(migratedTemplate()).toBe(migratedTemplate());
  });
});

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { dropRetiredCommitmentsTable, migrate, migrateOnBoot } from './migrate.js';
import { createEmptyTestDb, realPostgresUrl, type TestDbHandle } from './test-db.test-support.js';

// 台帳のテーブル `commitments` を落とす処理（#5469 P7 の段4）。落とすと閉じた行も戻せないので、
// 「未了が在れば落とさない」「無ければ何もしない」「2周目（1周目が残した表・行がある状態）でも通る」を、状態を挟んで測る。
// `createEmptyTestDb` を使うので、既定は PGlite、CI の real-postgres の job では実物の PostgreSQL で走る。

let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await createEmptyTestDb());
});

afterEach(async () => {
  await client.close();
});

// 段3までに入っていた台帳の表を、そのまま作る（表・連番・部分索引・マネージャー本文の一意索引）。
// 試験が自分で持つ: schema.ts の定義は段4で消えたので、旧い DB の形はここに固定する。
async function createLegacyCommitments(): Promise<void> {
  for (const statement of [
    `create table commitments (
       id text primary key,
       at timestamptz not null,
       closed_at timestamptz,
       commitment jsonb not null
     )`,
    `create index commitments_open_idx on commitments (at) where closed_at is null`,
    `alter table commitments add column seq bigint`,
    `create sequence commitments_seq_seq`,
    `alter table commitments alter column seq set default nextval('commitments_seq_seq')`,
    `create unique index commitments_open_manager_body_idx
       on commitments ((commitment->>'source'), md5(commitment->>'body'))
       where closed_at is null and commitment->>'origin' = 'manager'`,
  ]) {
    await db.execute(sql.raw(statement));
  }
}

const insertRow = (id: string, closedAt: string | null) =>
  db.execute(sql`
    insert into commitments (id, at, closed_at, commitment)
    values (${id}, ${'2026-09-17T00:00:00.000Z'}::timestamptz, ${closedAt}::timestamptz,
            ${JSON.stringify({ id, origin: 'self', body: `body ${id}` })}::jsonb)
  `);

function rowsOf(result: unknown): Record<string, unknown>[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Record<
    string,
    unknown
  >[];
}

async function relationPresent(name: string): Promise<boolean> {
  const result = await db.execute(
    sql`select to_regclass(${`public.${name}`}) is not null as present`,
  );
  return rowsOf(result)[0]?.present === true;
}

async function rowCount(): Promise<number> {
  const result = await db.execute(sql`select count(*)::int as n from commitments`);
  return Number(rowsOf(result)[0]?.n);
}

describe('dropRetiredCommitmentsTable', () => {
  it('⭐ 未了の行が1件でも在れば落とさず、件数を警告し、行は1件も減らない（閉じた行も残る）', async () => {
    await createLegacyCommitments();
    await insertRow('open-1', null);
    await insertRow('open-2', null);
    await insertRow('closed-1', '2026-09-18T00:00:00.000Z');

    const lines: string[] = [];
    await dropRetiredCommitmentsTable(db, (line) => lines.push(line));

    expect(await relationPresent('commitments')).toBe(true);
    expect(await relationPresent('commitments_seq_seq')).toBe(true);
    expect(await rowCount()).toBe(3);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('未了の行が 2 件残っている');
    expect(lines[0]).toContain('落とさなかった');
    expect(lines[0]).toContain('#5908');
  });

  it('⭐ 閉じた行だけなら、表と連番を落とし、そのことを1行出す', async () => {
    await createLegacyCommitments();
    await insertRow('closed-1', '2026-09-18T00:00:00.000Z');
    await insertRow('closed-2', '2026-09-19T00:00:00.000Z');

    const lines: string[] = [];
    await dropRetiredCommitmentsTable(db, (line) => lines.push(line));

    expect(await relationPresent('commitments')).toBe(false);
    expect(await relationPresent('commitments_seq_seq')).toBe(false);
    expect(await relationPresent('commitments_open_manager_body_idx')).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('落とした');
  });

  it('行が1件も無い表も落とす', async () => {
    await createLegacyCommitments();
    await dropRetiredCommitmentsTable(db, () => undefined);
    expect(await relationPresent('commitments')).toBe(false);
  });

  it('⭐ 表が無い DB では何も出さず何もしない。2回呼んでも通る', async () => {
    const lines: string[] = [];
    await dropRetiredCommitmentsTable(db, (line) => lines.push(line));
    await dropRetiredCommitmentsTable(db, (line) => lines.push(line));
    expect(lines).toEqual([]);
  });

  it('⭐ 落とした後にもう一度呼んでも、何も出さず通る（2回目以降の起動）', async () => {
    await createLegacyCommitments();
    await insertRow('closed-1', '2026-09-18T00:00:00.000Z');
    await dropRetiredCommitmentsTable(db, () => undefined);

    const lines: string[] = [];
    await dropRetiredCommitmentsTable(db, (line) => lines.push(line));
    expect(lines).toEqual([]);
  });

  it('並行に起動した2台が同時に打っても、落ちずに表が無くなる', async () => {
    await createLegacyCommitments();
    await insertRow('closed-1', '2026-09-18T00:00:00.000Z');

    const lines: string[] = [];
    await expect(
      Promise.all([
        dropRetiredCommitmentsTable(db, (line) => lines.push(line)),
        dropRetiredCommitmentsTable(db, (line) => lines.push(line)),
      ]),
    ).resolves.toBeDefined();

    expect(await relationPresent('commitments')).toBe(false);
    expect(lines.join('')).not.toContain('落とせなかった');
  });

  it('落とせなくても投げない（起動を止めず、警告して次の起動でやり直す）', async () => {
    await createLegacyCommitments();
    await insertRow('closed-1', '2026-09-18T00:00:00.000Z');

    const failing = {
      ...db,
      transaction: () => Promise.reject(new Error('仕込んだ失敗')),
      execute: db.execute.bind(db),
    } as unknown as Db;

    const lines: string[] = [];
    await expect(
      dropRetiredCommitmentsTable(failing, (line) => lines.push(line)),
    ).resolves.toBeUndefined();

    expect(await relationPresent('commitments')).toBe(true);
    expect(lines.join('')).toContain('落とせなかった');
    expect(lines.join('')).toContain('仕込んだ失敗');
  });
});

// 実物の PostgreSQL でだけ測れる（PGlite は接続が1本でロックの待ちが起きない）
describe.skipIf(realPostgresUrl() === undefined)(
  '旧デーモンが台帳の表を読んだままのとき（実物の PostgreSQL）',
  () => {
    it('⭐ ロックが取れない間は表を落とさず起動を止めずに警告し、読みが終われば次の呼び出しで落ちる', async () => {
      await createLegacyCommitments();
      await insertRow('closed-1', '2026-09-18T00:00:00.000Z');

      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reading!: () => void;
      const holding = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const reader = db.transaction(async (tx) => {
        await tx.execute(sql`select * from commitments`);
        reading();
        await released;
      });
      await holding;

      const lines: string[] = [];
      await expect(
        dropRetiredCommitmentsTable(db, (line) => lines.push(line), {
          lockTimeoutMs: 100,
          retryDelayMs: 10,
          maxAttempts: 2,
        }),
      ).resolves.toBeUndefined();
      expect(await relationPresent('commitments')).toBe(true);
      expect(lines.join('')).toContain('落とせなかった');

      release();
      await reader;

      const after: string[] = [];
      await dropRetiredCommitmentsTable(db, (line) => after.push(line));
      expect(await relationPresent('commitments')).toBe(false);
      expect(after.join('')).toContain('落とした');
    }, 30_000);
  },
);

describe('migrate / migrateOnBoot から落とす', () => {
  it('⭐ 新しい DB で migrate 全体が通り、commitments は作られず、警告も出ない。2周目も同じ', async () => {
    const lines: string[] = [];
    await migrate(db, (line) => lines.push(line));
    expect(await relationPresent('commitments')).toBe(false);
    expect(await relationPresent('commitments_seq_seq')).toBe(false);
    expect(await relationPresent('tasks')).toBe(true);

    await migrate(db, (line) => lines.push(line));
    await migrateOnBoot(db, (line) => lines.push(line));
    expect(await relationPresent('commitments')).toBe(false);
    expect(lines).toEqual([]);
  }, 60_000);

  it('⭐ 過去に台帳の表が入った DB（閉じた行だけ）で migrate すると、表・連番・索引が消える', async () => {
    await createLegacyCommitments();
    await insertRow('closed-1', '2026-09-18T00:00:00.000Z');

    const lines: string[] = [];
    await migrate(db, (line) => lines.push(line));

    expect(await relationPresent('commitments')).toBe(false);
    expect(await relationPresent('commitments_seq_seq')).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('落とした');
  }, 60_000);

  // 1周目が作った状態（未了の行が残った表・流し済みの指紋）を挟む: 同じ入り口を2回呼ぶだけでは、「行を閉じてから再起動すれば落ちる」を測れない
  it('⭐ 未了が在って落とさなかった起動のあと、行を閉じて再起動（指紋が一致する経路）すると落ちる', async () => {
    await createLegacyCommitments();
    await insertRow('open-1', null);

    const first: string[] = [];
    await migrateOnBoot(db, (line) => first.push(line));
    expect(await relationPresent('commitments')).toBe(true);
    expect(first.join('')).toContain('未了の行が 1 件残っている');

    const stillOpen: string[] = [];
    await migrateOnBoot(db, (line) => stillOpen.push(line));
    expect(await relationPresent('commitments')).toBe(true);
    expect(stillOpen.join('')).toContain('未了の行が 1 件残っている');

    await db.execute(sql`update commitments set closed_at = now() where id = 'open-1'`);

    const last: string[] = [];
    await migrateOnBoot(db, (line) => last.push(line));
    expect(await relationPresent('commitments')).toBe(false);
    expect(last).toHaveLength(1);
    expect(last[0]).toContain('落とした');

    const after: string[] = [];
    await migrateOnBoot(db, (line) => after.push(line));
    expect(after).toEqual([]);
  }, 60_000);
});

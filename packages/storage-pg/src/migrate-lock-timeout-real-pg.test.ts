import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { migrate } from './migrate.js';
import { createEmptyTestDb, realPostgresUrl, type TestDbHandle } from './test-db.test-support.js';

// 実物の PostgreSQL でだけ測れる（PGlite は接続が1本でロックの待ちが起きない）。CI の real-postgres の job で走る（#4747）

const handles: TestDbHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

async function freshDb(): Promise<Db> {
  const created = await createEmptyTestDb();
  handles.push(created.client);
  return created.db;
}

// 先行の長い読み: memory の共有ロックを握ったまま `holdMs` だけトランザクションを開けておき、その間に memory へ書いた最長の待ちを返す
async function longestWriteWhileMigrating(db: Db, lockTimeoutMs: number): Promise<number> {
  const HOLD_MS = 3_000;
  let reading!: () => void;
  const holding = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const reader = db.transaction(async (tx) => {
    await tx.execute(sql`select * from memory`);
    reading();
    await tx.execute(sql.raw(`select pg_sleep(${String(HOLD_MS / 1000)})`));
  });
  await holding;

  let readerDone = false;
  void reader.then(() => {
    readerDone = true;
  });
  const migrating = migrate(db, () => undefined, { lockTimeoutMs, retryDelayMs: 50 });
  // 読みが終わるまで書き続け、いちばん長く待たされた時間を測る（間は SQL の pg_sleep で空ける）
  let longest = 0;
  for (let i = 0; !readerDone; i += 1) {
    const started = Date.now();
    await db.execute(sql`insert into memory (slug, content) values (${`probe-${String(i)}`}, 'x')`);
    longest = Math.max(longest, Date.now() - started);
    await db.execute(sql`select pg_sleep(0.05)`);
  }
  await reader;
  await migrating;
  return longest;
}

describe.skipIf(realPostgresUrl() === undefined)(
  'マイグレーションのロックの待ちの上限（#4747、実物の PostgreSQL）',
  () => {
    it('⭐ 先行の読みがロックを握っていても、ALTER の待ちが上限で切れるので、memory への書き込みが長く止まらない', async () => {
      const db = await freshDb();
      await migrate(db, () => undefined);
      const longest = await longestWriteWhileMigrating(db, 200);
      expect(longest).toBeLessThan(1_500);
    }, 60_000);

    it('対照: 待ちに上限が無ければ（60 秒）、書き込みは読みが終わるまで止まる（今までの振る舞い）', async () => {
      const db = await freshDb();
      await migrate(db, () => undefined);
      const longest = await longestWriteWhileMigrating(db, 60_000);
      expect(longest).toBeGreaterThan(1_500);
    }, 60_000);

    it('⭐ 2つのデーモンが空の DB へ同時に初回のマイグレーションを流しても、両方通る', async () => {
      const db = await freshDb();
      await expect(
        Promise.all([
          migrate(db, () => undefined, { retryDelayMs: 50 }),
          migrate(db, () => undefined, { retryDelayMs: 50 }),
        ]),
      ).resolves.toBeDefined();
    }, 120_000);
  },
);

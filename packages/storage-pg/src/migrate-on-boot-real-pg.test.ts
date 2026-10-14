import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { migrate, migrateOnBoot } from './migrate.js';
import { createEmptyTestDb, realPostgresUrl, type TestDbHandle } from './test-db.test-support.js';

// 実物の PostgreSQL でだけ測れる（PGlite は接続が1本でロックの待ちが起きない）。CI の real-postgres の job で走る（#4731）

let handle: TestDbHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

const WAIT_LIMIT_MS = 3_000;

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timed-out'> {
  return Promise.race([
    promise,
    new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), ms)),
  ]);
}

describe.skipIf(realPostgresUrl() === undefined)(
  '起動のたびのマイグレーションが、先行の読みの間テーブルを止めない（#4731、実物の PostgreSQL）',
  () => {
    it('⭐ memory を読んだまま開いているトランザクションがあっても、2回目の起動のマイグレーションは待たされずに終わる', async () => {
      const created = await createEmptyTestDb();
      handle = created.client;
      const { db } = created;
      await migrateOnBoot(db, () => undefined);

      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reading!: () => void;
      const holding = new Promise<void>((resolve) => {
        reading = resolve;
      });
      // 先行の長い読み: memory の共有ロックを握ったままトランザクションを開けておく
      const reader = db.transaction(async (tx) => {
        await tx.execute(sql`select * from memory`);
        reading();
        await released;
      });
      await holding;

      const outcome = await within(
        migrateOnBoot(db, () => undefined),
        WAIT_LIMIT_MS,
      );
      release();
      await reader;
      expect(outcome).not.toBe('timed-out');
    }, 30_000);

    it('対照: 毎回すべて流す migrate() は、同じ読みの間は待たされる（何もしない ALTER がロックを取りに行く）', async () => {
      const created = await createEmptyTestDb();
      handle = created.client;
      const { db } = created;
      await migrate(db, () => undefined);

      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reading!: () => void;
      const holding = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const reader = db.transaction(async (tx) => {
        await tx.execute(sql`select * from memory`);
        reading();
        await released;
      });
      await holding;

      const running = migrate(db, () => undefined);
      const outcome = await within(running, WAIT_LIMIT_MS);
      release();
      await reader;
      await running;
      expect(outcome).toBe('timed-out');
    }, 30_000);
  },
);

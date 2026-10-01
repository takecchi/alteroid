import type {
  NotificationCursorRead,
  NotificationReadCursor,
  NotificationStore,
} from '@alteroid/core';
import { eq, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { notificationCursor } from './schema.js';

/** 高々1行しか持たない表なので、鍵は固定でよい（`env_profile` と同じ作法）。 */
const CURSOR_ID = 'default';

/**
 * 人間への通知の既読の位置（クラウド段。issue #2515）。
 *
 * fs 版（`jobs/notifications.json`）と同じものの器違いである。
 *
 * **「戻らない」は1文の upsert の中で決める**（`greatest`）。読んでから書く形に
 * すると、その間に別の入口が進めた位置を古い値で踏み戻しうる。
 */
export class PgNotificationStore implements NotificationStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async readCursor(): Promise<NotificationCursorRead> {
    const rows = await this.#db
      .select({
        readThrough: notificationCursor.readThrough,
        updatedAt: notificationCursor.updatedAt,
      })
      .from(notificationCursor)
      .where(eq(notificationCursor.id, CURSOR_ID))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return { state: 'none' };
    return {
      state: 'ok',
      cursor: {
        readThrough: row.readThrough.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  }

  async advanceReadCursor(through: string): Promise<NotificationReadCursor> {
    const at = new Date();
    const rows = await this.#db
      .insert(notificationCursor)
      .values({ id: CURSOR_ID, readThrough: new Date(through), updatedAt: at })
      .onConflictDoUpdate({
        target: notificationCursor.id,
        set: {
          readThrough: sql`greatest(${notificationCursor.readThrough}, excluded.read_through)`,
          // 位置が動いたときだけ時刻を進める（動かなかった呼びを「最後に既読にした
          // 時刻」として残さない）。
          updatedAt: sql`case when excluded.read_through > ${notificationCursor.readThrough} then excluded.updated_at else ${notificationCursor.updatedAt} end`,
        },
      })
      .returning({
        readThrough: notificationCursor.readThrough,
        updatedAt: notificationCursor.updatedAt,
      });
    const row = rows[0];
    if (row === undefined) throw new Error('notification_cursor への書き込みが行を返さなかった');
    return { readThrough: row.readThrough.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }
}

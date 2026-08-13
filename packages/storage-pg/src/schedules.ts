import { scheduledRequestSchema } from '@alteroid/core';
import type { ScheduleStore, ScheduledRequest } from '@alteroid/core';
import { asc, eq, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
import { schedules } from './schema.js';

/**
 * 継続中の依頼（時間起点の仕込み）。
 *
 * fs 版と同じ IF を満たすための別の器であって、器の違いで能力差を作らない
 * （クラウドでだけ「定期的にやって」が効かない、が起きない）。
 */
export class PgScheduleStore implements ScheduleStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(): Promise<ScheduledRequest[]> {
    const rows = await this.#db
      .select({ plan: schedules.plan })
      .from(schedules)
      .orderBy(asc(schedules.kind));
    return rows.flatMap((row) => {
      const parsed = scheduledRequestSchema.safeParse(row.plan);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async get(kind: string): Promise<ScheduledRequest | null> {
    const rows = await this.#db
      .select({ plan: schedules.plan })
      .from(schedules)
      .where(eq(schedules.kind, kind))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = scheduledRequestSchema.safeParse(row.plan);
    return parsed.success ? parsed.data : null;
  }

  async put(entry: ScheduledRequest): Promise<void> {
    // 依頼の本文は人間かクローンが書いた自由文なので NUL が混ざりうる
    const value = stripNulls(scheduledRequestSchema.parse(entry));
    await this.#db
      .insert(schedules)
      .values({
        kind: value.kind,
        createdAt: new Date(value.createdAt),
        updatedAt: new Date(value.updatedAt),
        lastRunAt: value.lastRunAt === undefined ? null : new Date(value.lastRunAt),
        plan: value,
      })
      .onConflictDoUpdate({
        target: schedules.kind,
        set: {
          updatedAt: new Date(value.updatedAt),
          lastRunAt: value.lastRunAt === undefined ? null : new Date(value.lastRunAt),
          plan: value,
        },
      });
  }

  async remove(kind: string): Promise<void> {
    await this.#db.delete(schedules).where(eq(schedules.kind, kind));
  }

  /**
   * 発火の記録。
   *
   * jsonb の中も一緒に直す（読み出しは `plan` からなので、列だけ直しても
   * クローンが見る値は変わらない）。知らない kind なら 0 行更新で何も起きない。
   */
  async markRun(kind: string, at: string): Promise<void> {
    const stamp = new Date(at);
    await this.#db
      .update(schedules)
      .set({
        updatedAt: stamp,
        lastRunAt: stamp,
        plan: sql`jsonb_set(jsonb_set(${schedules.plan}, '{lastRunAt}', ${JSON.stringify(at)}::jsonb, true), '{updatedAt}', ${JSON.stringify(at)}::jsonb, true)`,
      })
      .where(eq(schedules.kind, kind));
  }
}

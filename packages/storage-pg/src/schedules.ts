import { scheduledRequestSchema } from '@alteroid/core';
import type { ScheduleStore, ScheduledRequest } from '@alteroid/core';
import { asc, eq, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
import { schedules } from './schema.js';

/**
 * 行が読めなければ落とさずに投げる。
 *
 * **他のストア（jobs / journal）と作法が違うのは意図的である。** あちらは1行
 * 壊れても一覧が返るべき記録だが、こちらは「いつ何を頼まれたか」そのものなので、
 * 読めない行を黙って飛ばすと**消された依頼と区別が付かなくなる**。
 *
 * 区別が消えると具体的にこう壊れる: 発火した依頼の `get()` が `null` を返し、
 * クローンは「人間が手で仕込んだ kind を起こした」と解釈して本文なしの曖昧な
 * ターンを走らせる（`clone.ts` が読取不能と `null` を分けている意味が無くなる）。
 * `refresh()` と digest / `schedule_list` からも消えるので、人間にも原因が見えない。
 * fs 版（ファイル全体を `parse` する）と同じく、壊れた永続状態は表に出す。
 */
function parsePlan(kind: string, value: unknown): ScheduledRequest {
  const parsed = scheduledRequestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    `継続中の依頼 ${kind} が読めない形で入っている（消されたのではない）: ${parsed.error.message}`,
  );
}

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
      .select({ kind: schedules.kind, plan: schedules.plan })
      .from(schedules)
      .orderBy(asc(schedules.kind));
    return rows.map((row) => parsePlan(row.kind, row.plan));
  }

  async get(kind: string): Promise<ScheduledRequest | null> {
    const rows = await this.#db
      .select({ plan: schedules.plan })
      .from(schedules)
      .where(eq(schedules.kind, kind))
      .limit(1);
    const row = rows[0];
    // **無いこと（消された）と、読めないことは別物である。** 前者だけが null。
    if (row === undefined) return null;
    return parsePlan(kind, row.plan);
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
   *
   * **`updatedAt` は動かさない** — あれは「依頼が最後に書き換えられた時刻」であり、
   * 発火で上書きすると人間が「この依頼いつ直したか」を追えなくなる。
   */
  async markRun(kind: string, at: string): Promise<void> {
    await this.#db
      .update(schedules)
      .set({
        lastRunAt: new Date(at),
        plan: sql`jsonb_set(${schedules.plan}, '{lastRunAt}', ${JSON.stringify(at)}::jsonb, true)`,
      })
      .where(eq(schedules.kind, kind));
  }
}

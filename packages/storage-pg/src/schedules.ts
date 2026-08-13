import { scheduledRequestSchema } from '@alteroid/core';
import type { ScheduleStore, ScheduledRequest } from '@alteroid/core';
import { and, asc, eq, sql } from 'drizzle-orm';

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
   * 発火の確定。**同じ版がまだ在るときだけ記録する。**
   *
   * 行を `for update` で押さえてから条件を見るので、読んでから書くまでの隙間に
   * `remove` / `put` が割り込めない。版の識別子は `updatedAt`（jsonb 側の値で
   * 突き合わせる。列と jsonb が食い違っていても、クローンが読むのは jsonb である）。
   *
   * jsonb の中も一緒に直す（読み出しは `plan` からなので、列だけ直してもクローンが
   * 見る値は変わらない）。**`updatedAt` は動かさない** — 人間が「この依頼いつ直したか」
   * を追う手がかりであり、同時に版の識別子でもある。
   */
  async claimRun(
    kind: string,
    expectedUpdatedAt: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<ScheduledRequest | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ plan: schedules.plan })
        .from(schedules)
        .where(eq(schedules.kind, kind))
        .limit(1)
        .for('update');
      const row = rows[0];
      // 消された。**古い本文で動かさない。**
      if (row === undefined) return null;

      const plan = parsePlan(kind, row.plan);
      // 書き換わった。人間の直しを無視して古い本文で動くのが一番まずい。
      if (plan.updatedAt !== expectedUpdatedAt) return null;

      // 引き受けた印と観測用の時刻だけ。定期の基準は `completeRun` で進める
      const stamped = sql`jsonb_set(jsonb_set(${schedules.plan}, '{lastRunAt}', ${JSON.stringify(at)}::jsonb, true), '{pendingRun}', ${JSON.stringify({ at, cause })}::jsonb, true)`;

      await tx
        .update(schedules)
        .set({ lastRunAt: new Date(at), plan: stamped })
        .where(eq(schedules.kind, kind));

      // 返すのは更新前の姿（呼び出し側は「前回いつ動いたか」と、前の発火が
      // 終わっていたかを材料に要る）
      return plan;
    });
  }

  async completeRun(kind: string, at: string, cause: 'schedule' | 'manual'): Promise<void> {
    const cleared =
      cause === 'schedule'
        ? sql`jsonb_set(${schedules.plan} - 'pendingRun', '{lastScheduledRunAt}', ${JSON.stringify(at)}::jsonb, true)`
        : sql`${schedules.plan} - 'pendingRun'`;

    // 別の発火の印が付いているなら触らない（後から来た発火のものを消さない）
    await this.#db
      .update(schedules)
      .set({ plan: cleared })
      .where(
        and(eq(schedules.kind, kind), sql`${schedules.plan} -> 'pendingRun' ->> 'at' = ${at}`),
      );
  }
}

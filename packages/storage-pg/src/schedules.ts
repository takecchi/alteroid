import {
  ScheduleConflictError,
  UnreadableScheduleError,
  scheduleVersionMatches,
  assertNoNul,
  hasNul,
  stripNul,
  schedulePhaseSchema,
  scheduledRequestSchema,
} from '@alteroid/core';
import type {
  SchedulePhase,
  ScheduleList,
  ScheduleSpec,
  ScheduleStore,
  ScheduledRequest,
  UnreadableSchedule,
  WriteScheduleOptions,
} from '@alteroid/core';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { byteOrder, stripNulls } from './db.js';
import { schedulePhases, schedules } from './schema.js';

/**
 * 読めない行を `get()` が `null` にしない: 区別が消えると、クローンが発火した依頼を「人間が手で仕込んだ kind」と解釈して
 * 本文なしの曖昧なターンを走らせる（`clone.ts` が読取不能と `null` を分けている）。`list()` だけは飛ばして stderr に跡を残す。
 */
function parsePlan(kind: string, value: unknown): ScheduledRequest {
  const parsed = scheduledRequestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new UnreadableScheduleError(
    `継続中の依頼 ${kind} が読めない形で入っている（消されたのではない）: ${parsed.error.message}`,
    { kind },
  );
}

/** `issue.message` は使わない: zod の既定メッセージが `received`（実際の値）を含む形に変わっても値が漏れないように、欄名だけを出す。 */
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

/** kind 以外の値は載せない: `request` には人間の依頼文がそのまま入りうる。 */
function describeSkippedScheduleRow(params: { kind: string; reason: string }): string {
  return `alteroid: 継続中の依頼の不正な行を読み飛ばしました（kind=${JSON.stringify(params.kind)}、${params.reason}）`;
}

export class PgScheduleStore implements ScheduleStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(): Promise<ScheduleList> {
    const rows = await this.#db
      .select({ kind: schedules.kind, plan: schedules.plan })
      .from(schedules)
      .orderBy(asc(byteOrder(schedules.kind)));
    const entries: ScheduledRequest[] = [];
    const unreadable: UnreadableSchedule[] = [];
    for (const row of rows) {
      const parsed = scheduledRequestSchema.safeParse(row.plan);
      if (parsed.success) {
        entries.push(parsed.data);
        continue;
      }
      const reason = summarizeInvalidFields(parsed.error.issues);
      process.stderr.write(`${describeSkippedScheduleRow({ kind: row.kind, reason })}\n`);
      unreadable.push({ kind: row.kind, reason });
    }
    return { entries, unreadable };
  }

  async get(kind: string): Promise<ScheduledRequest | null> {
    // NUL を含む鍵の行は存在しえない（書き込みが断る）ので「無い」。DB に投げると NUL を含む text を受け付けずエラーになる。
    if (hasNul(kind)) return null;
    const rows = await this.#db
      .select({ plan: schedules.plan })
      .from(schedules)
      .where(eq(schedules.kind, kind))
      .limit(1);
    const row = rows[0];
    // 無いこと（消された）と読めないことは別物: 前者だけが null。
    if (row === undefined) return null;
    return parsePlan(kind, row.plan);
  }

  async put(entry: ScheduledRequest, options?: WriteScheduleOptions): Promise<void> {
    // 依頼の本文は人間かクローンが書いた自由文なので NUL が混ざりうる。空になるものも含めて、落としてから検証する。
    const value = stripNulls(
      scheduledRequestSchema.parse({ ...entry, request: stripNul(entry.request) }),
    );
    const values = {
      kind: value.kind,
      createdAt: new Date(value.createdAt),
      updatedAt: new Date(value.updatedAt),
      lastRunAt: value.lastRunAt === undefined ? null : new Date(value.lastRunAt),
      plan: value,
    };
    const set = {
      updatedAt: new Date(value.updatedAt),
      lastRunAt: value.lastRunAt === undefined ? null : new Date(value.lastRunAt),
      plan: value,
    };
    const ifMatch = options?.ifMatch;
    if (ifMatch === undefined) {
      await this.#db
        .insert(schedules)
        .values(values)
        .onConflictDoUpdate({ target: schedules.kind, set });
      return;
    }
    // 行が無いときはロックする行が無いので、`onConflictDoNothing` が「同時に作った別の書き手」を弾く。
    await this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ plan: schedules.plan })
        .from(schedules)
        .where(eq(schedules.kind, value.kind))
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row === undefined) {
        if (typeof ifMatch === 'string') throw new ScheduleConflictError(value.kind, null);
        const inserted = await tx
          .insert(schedules)
          .values(values)
          .onConflictDoNothing({ target: schedules.kind })
          .returning({ kind: schedules.kind });
        if (inserted[0] === undefined) {
          const again = await tx
            .select({ plan: schedules.plan })
            .from(schedules)
            .where(eq(schedules.kind, value.kind))
            .limit(1);
          const raced = again[0];
          throw new ScheduleConflictError(
            value.kind,
            raced === undefined ? null : parsePlan(value.kind, raced.plan),
          );
        }
        return;
      }
      const current = parsePlan(value.kind, row.plan);
      if (!scheduleVersionMatches(current, ifMatch)) {
        throw new ScheduleConflictError(value.kind, current);
      }
      await tx.update(schedules).set(set).where(eq(schedules.kind, value.kind));
    });
  }

  async remove(kind: string): Promise<void> {
    // NUL を含む鍵の行は存在しえない（書き込みが断る）ので「無い」。DB に投げると NUL を含む text を受け付けずエラーになる。
    if (hasNul(kind)) return;
    await this.#db.delete(schedules).where(eq(schedules.kind, kind));
  }

  /** `get()` を先に呼ばず `DELETE … RETURNING` の1文で済ませる: 読んでから書くまでの隙間を作らない。 */
  async removeIfPresent(kind: string): Promise<ScheduledRequest | 'unreadable' | null> {
    // NUL を含む鍵の行は存在しえない（書き込みが断る）ので「無い」。DB に投げると NUL を含む text を受け付けずエラーになる。
    if (hasNul(kind)) return null;
    const rows = await this.#db
      .delete(schedules)
      .where(eq(schedules.kind, kind))
      .returning({ plan: schedules.plan });
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = scheduledRequestSchema.safeParse(row.plan);
    return parsed.success ? parsed.data : 'unreadable';
  }

  /** `for update` で押さえてから読み直した現在値を引き継ぐ: `pendingRun` 等が割り込みで消えないように。`updatedAt` は本文の編集なので進める。 */
  async editRequest(
    kind: string,
    changes: { readonly request: string; readonly spec: ScheduleSpec },
    updatedAt: string,
    options?: WriteScheduleOptions,
  ): Promise<ScheduledRequest | null> {
    // NUL を含む鍵の行は存在しえない（書き込みが断る）ので「無い」。DB に投げると NUL を含む text を受け付けずエラーになる。
    if (hasNul(kind)) return null;
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ plan: schedules.plan })
        .from(schedules)
        .where(eq(schedules.kind, kind))
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row === undefined) {
        if (typeof options?.ifMatch === 'string') throw new ScheduleConflictError(kind, null);
        return null;
      }

      const plan = parsePlan(kind, row.plan);
      if (!scheduleVersionMatches(plan, options?.ifMatch)) {
        throw new ScheduleConflictError(kind, plan);
      }
      const next = stripNulls(
        scheduledRequestSchema.parse({
          ...plan,
          request: stripNul(changes.request),
          spec: changes.spec,
          updatedAt,
        }),
      );

      await tx
        .update(schedules)
        .set({ updatedAt: new Date(updatedAt), plan: next })
        .where(eq(schedules.kind, kind));

      return next;
    });
  }

  /**
   * 版の突き合わせは jsonb 側の `updatedAt` で行う: 列と jsonb が食い違っていても、クローンが読むのは jsonb である。
   * jsonb の中も一緒に直す: 列だけ直してもクローンが見る値は変わらない。
   * `updatedAt` は動かさない: 版の識別子でもある。
   */
  async claimRun(
    kind: string,
    expectedUpdatedAt: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<ScheduledRequest | null> {
    // NUL を含む鍵の行は存在しえない（書き込みが断る）ので「無い」。DB に投げると NUL を含む text を受け付けずエラーになる。
    if (hasNul(kind)) return null;
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ plan: schedules.plan })
        .from(schedules)
        .where(eq(schedules.kind, kind))
        .limit(1)
        .for('update');
      const row = rows[0];
      // 古い本文で動かさない。
      if (row === undefined) return null;

      const plan = parsePlan(kind, row.plan);
      // 人間の直しを無視して古い本文で動くのが一番まずい。
      if (plan.updatedAt !== expectedUpdatedAt) return null;

      // 定期の基準は `completeRun` で進める
      const stamped = sql`jsonb_set(jsonb_set(${schedules.plan}, '{lastRunAt}', ${JSON.stringify(at)}::jsonb, true), '{pendingRun}', ${JSON.stringify({ at, cause })}::jsonb, true)`;

      await tx
        .update(schedules)
        .set({ lastRunAt: new Date(at), plan: stamped })
        .where(eq(schedules.kind, kind));

      return plan;
    });
  }

  async completeRun(kind: string, at: string, cause: 'schedule' | 'manual'): Promise<void> {
    // NUL を含む鍵の行は存在しえない（書き込みが断る）ので「無い」。DB に投げると NUL を含む text を受け付けずエラーになる。
    if (hasNul(kind)) return;
    const cleared =
      cause === 'schedule'
        ? sql`jsonb_set(${schedules.plan} - 'pendingRun', '{lastScheduledRunAt}', ${JSON.stringify(at)}::jsonb, true)`
        : sql`${schedules.plan} - 'pendingRun'`;

    // 別の発火の印が付いているなら触らない: 後から来た発火のものを消さない。
    await this.#db
      .update(schedules)
      .set({ plan: cleared })
      .where(
        and(eq(schedules.kind, kind), sql`${schedules.plan} -> 'pendingRun' ->> 'at' = ${at}`),
      );
  }

  /** 読めない行を `null` にしない: 「まだ一度も動いていない」と区別が付かず、位相が静かに捨てられる。 */
  async getPhase(kind: string): Promise<SchedulePhase | null> {
    // NUL を含む鍵の行は存在しえない（書き込みが断る）ので「無い」。DB に投げると NUL を含む text を受け付けずエラーになる。
    if (hasNul(kind)) return null;
    const rows = await this.#db
      .select({ phase: schedulePhases.phase })
      .from(schedulePhases)
      .where(eq(schedulePhases.kind, kind))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = schedulePhaseSchema.safeParse(row.phase);
    if (parsed.success) return parsed.data;
    throw new Error(
      `定期ジョブ ${kind} の位相が読めない形で入っている（まだ動いていないのではない）: ${parsed.error.message}`,
    );
  }

  async putPhase(phase: SchedulePhase): Promise<void> {
    assertNoNul('schedulePhase.kind', phase.kind);
    const value = schedulePhaseSchema.parse(phase);
    const updatedAt = new Date(value.lastRunAt ?? value.lastScheduledRunAt ?? Date.now());
    await this.#db
      .insert(schedulePhases)
      .values({ kind: value.kind, updatedAt, phase: value })
      .onConflictDoUpdate({
        target: schedulePhases.kind,
        set: { updatedAt, phase: value },
      });
  }

  /** 1つのトランザクションで束ねる: 束ねないと2文目が落ちたときに1文目の DELETE だけが確定し、呼び手が「何も消えていない」と読みうる。 */
  async clear(): Promise<{ schedules: number; phases: number }> {
    return this.#db.transaction(async (tx) => {
      const removedSchedules = await tx.delete(schedules).returning({ kind: schedules.kind });
      const removedPhases = await tx
        .delete(schedulePhases)
        .returning({ kind: schedulePhases.kind });
      return { schedules: removedSchedules.length, phases: removedPhases.length };
    });
  }
}

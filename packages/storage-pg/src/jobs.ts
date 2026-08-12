import { jobSchema, pendingApprovalSchema } from '@alteroid/core';
import type { Job, JobStore, PendingApproval } from '@alteroid/core';
import { asc, eq, isNull } from 'drizzle-orm';

import type { Db } from './db.js';
import { approvals, jobs } from './schema.js';

/**
 * ジョブ台帳と承認待ちキュー。
 *
 * ジョブ行が持つ `session_id`（jsonb の中）が、デーモン再起動後にマネージャーの
 * 続きへ戻るための足がかりである（roadmap M4）。
 */
export class PgJobStore implements JobStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async listJobs(): Promise<Job[]> {
    const rows = await this.#db.select({ job: jobs.job }).from(jobs).orderBy(asc(jobs.createdAt));
    return rows.flatMap((row) => {
      const parsed = jobSchema.safeParse(row.job);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async putJob(job: Job): Promise<void> {
    const value = jobSchema.parse(job);
    await this.#db
      .insert(jobs)
      .values({
        id: value.id,
        status: value.status,
        createdAt: new Date(value.createdAt),
        updatedAt: new Date(value.updatedAt),
        job: value,
      })
      .onConflictDoUpdate({
        target: jobs.id,
        set: { status: value.status, updatedAt: new Date(value.updatedAt), job: value },
      });
  }

  async listApprovals(options: { pendingOnly?: boolean } = {}): Promise<PendingApproval[]> {
    const rows = await this.#db
      .select({ approval: approvals.approval })
      .from(approvals)
      .where(options.pendingOnly === true ? isNull(approvals.answeredAt) : undefined)
      .orderBy(asc(approvals.createdAt));
    return rows.flatMap((row) => {
      const parsed = pendingApprovalSchema.safeParse(row.approval);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async getApproval(id: string): Promise<PendingApproval | null> {
    const rows = await this.#db
      .select({ approval: approvals.approval })
      .from(approvals)
      .where(eq(approvals.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = pendingApprovalSchema.safeParse(row.approval);
    return parsed.success ? parsed.data : null;
  }

  async putApproval(approval: PendingApproval): Promise<void> {
    const value = pendingApprovalSchema.parse(approval);
    const answeredAt = value.answeredAt === undefined ? null : new Date(value.answeredAt);
    await this.#db
      .insert(approvals)
      .values({
        id: value.id,
        createdAt: new Date(value.createdAt),
        answeredAt,
        approval: value,
      })
      .onConflictDoUpdate({
        target: approvals.id,
        set: { answeredAt, approval: value },
      });
  }
}

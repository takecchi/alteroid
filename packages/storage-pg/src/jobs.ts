import {
  jobSchema,
  journalRowType,
  noteDroppedJournalRow,
  noteDroppedJournalRowsSummary,
  pendingApprovalSchema,
} from '@alteroid/core';
import type { Job, JobStore, PendingApproval } from '@alteroid/core';
import { asc, eq, isNull } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
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

  /**
   * スキーマに合わない行は**飛ばすが、飛ばしたことは跡に残す**
   * （Issue #224。日誌の `PgJournalStore#list` と同じ道具・同じ形で揃える —
   * 同じ欠陥に2つの形を作らない、という決裁）。
   *
   * `Job` は `journalEntrySchema` と違って判別子の `type` を持たないので、
   * `journalRowType` はほぼ常に `undefined` を返す（それでよい —
   * `journalRowType` は値を型で判定するだけで、`Job` を特別扱いしない）。
   *
   * `safeParse` の `error.message` は跡へ渡さない（失敗した値そのものを
   * 引用しうる。`packages/core/src/dropped-record.ts` の
   * `noteDroppedJournalRow` の doc）。載せるのは `journalRowType` で安全に
   * 取れた `type` とバイト数だけ。
   */
  async listJobs(): Promise<Job[]> {
    const rows = await this.#db.select({ job: jobs.job }).from(jobs).orderBy(asc(jobs.createdAt));
    const found: Job[] = [];
    // 呼び出し1回ぶんのローカルな器（`PgJournalStore#list` と同じ理由 — Issue #224）。
    const dropped = new Map<string, number>();
    for (const row of rows) {
      const parsed = jobSchema.safeParse(row.job);
      if (parsed.success) {
        found.push(parsed.data);
      } else {
        noteDroppedJournalRow(
          dropped,
          'unknown-shape',
          journalRowType(row.job),
          byteLength(row.job),
        );
      }
    }
    noteDroppedJournalRowsSummary(dropped);
    return found;
  }

  async putJob(job: Job): Promise<void> {
    // 依頼文や報告に NUL が混ざりうる（マネージャーの出力をそのまま持つため）
    const value = stripNulls(jobSchema.parse(job));
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
    const value = stripNulls(pendingApprovalSchema.parse(approval));
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

/**
 * jsonb から読み出した（既に解かれた）値のバイト数を測る。`PgJournalStore` の
 * 同名関数と同じ実装（jsonb は pg の駆動子が読み出す時点で JS の値へ解いて
 * しまっているので、`JSON.stringify` へ戻して UTF-8 バイト数を数える）。
 * ファイルをまたいで共有する口が無いので複製している — 跡へ渡すのは数値だけで、
 * 本文を載せないという契約はどちらの複製でも同じである。
 */
function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

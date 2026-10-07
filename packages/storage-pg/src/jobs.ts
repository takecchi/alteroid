import {
  hasNul,
  jobSchema,
  prepareApprovalForWrite,
  prepareJobForWrite,
  journalRowType,
  noteDroppedJournalRow,
  noteDroppedJournalRowsSummary,
  pendingApprovalSchema,
  UnreadableApprovalError,
  UnreadableJobError,
} from '@alteroid/core';
import type {
  ApprovalList,
  Job,
  JobStore,
  PendingApproval,
  UnreadableApproval,
  UnreadableJob,
} from '@alteroid/core';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
import { approvals, jobs } from './schema.js';

// `migrate.ts` の `approvals_conversation_id_idx` と同じ式にする: 違うと索引が効かないため。
const CONVERSATION_ID_EXPR = sql`(${approvals.approval}->>'conversationId')`;

// `issue.message` を使わない: zod の既定メッセージが将来 `received`（実際の値）を含む形に変わっても値が漏れないようにするため。
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

// id 以外の値を載せない: job の欄には人間の依頼文・マネージャーの報告が入りうるため。
function describeUnreadableJobRow(params: { id: string; reason: string }): string {
  return (
    `alteroid: updateJob() で job 行を読み出せませんでした` +
    `（id=${JSON.stringify(params.id)}、${params.reason}）`
  );
}

// id 以外の値を載せない: 承認の欄には質問文・文脈・人間の回答が入りうるため。
function describeUnreadableApprovalRow(params: { op: string; id: string; reason: string }): string {
  return (
    `alteroid: ${params.op}() で承認待ちの行を読み出せませんでした` +
    `（id=${JSON.stringify(params.id)}、${params.reason}）`
  );
}

type JobCacheEntry =
  | { version: string; ok: true; job: Job }
  | {
      version: string;
      ok: false;
      type: string | undefined;
      bytes: number;
      reason: string;
    };

// `updated_at` だけを版にしない: ミリ秒粒度で、同じミリ秒の2回の上書きが衝突するため。`xmin` と連結する。
function jobRowVersion(xmin: string, updatedAt: Date): string {
  return `${xmin}|${updatedAt.toISOString()}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export class PgJobStore implements JobStore {
  readonly #db: Db;

  // 覚えに上限（LRU 等）を置かない: 溢れた行だけ毎回引き直しに戻り、出力に現れない静かな部分退行になるため。
  // `job` を凍らせる: `ManagerPool` が返した `Job` を直接書き換えるので、覚えが汚染され未 `putJob` の値が他の呼び手に見えるため。
  // 結果を覚えの中身から組まない: 段1の id の並びから組むことで、台帳から消えた行が結果から落ちるため。
  readonly #cache = new Map<string, JobCacheEntry>();

  constructor(db: Db) {
    this.#db = db;
  }

  async listJobs(): Promise<Job[]> {
    const { found, skipped } = await this.#scan();
    // 跡を `listUnreadableJobs()` では残さない: 同じ行を2つの口で数えないため。
    const dropped = new Map<string, number>();
    for (const row of skipped) {
      noteDroppedJournalRow(dropped, 'unknown-shape', row.type, row.bytes);
    }
    noteDroppedJournalRowsSummary(dropped);
    return found;
  }

  async listUnreadableJobs(): Promise<UnreadableJob[]> {
    const { skipped } = await this.#scan();
    return skipped.map((row): UnreadableJob => ({ id: row.id, reason: row.reason }));
  }

  async #scan(): Promise<{
    found: Job[];
    skipped: { id: string; reason: string; type: string | undefined; bytes: number }[];
  }> {
    const rows = await this.#db
      .select({ id: jobs.id, xmin: sql<string>`xmin::text`, updatedAt: jobs.updatedAt })
      .from(jobs)
      .orderBy(asc(jobs.createdAt));

    const versionById = new Map<string, string>();
    const staleIds: string[] = [];
    for (const row of rows) {
      const version = jobRowVersion(row.xmin, row.updatedAt);
      versionById.set(row.id, version);
      const cached = this.#cache.get(row.id);
      if (cached === undefined || cached.version !== version) staleIds.push(row.id);
    }

    // 全行 stale のときは `inArray` を経由しない: バインド変数が1クエリ65,535個までで、台帳がそれを超えると冷たい1回目が落ちるため。
    if (staleIds.length > 0) {
      const freshRows =
        staleIds.length === rows.length
          ? await this.#db.select({ id: jobs.id, job: jobs.job }).from(jobs)
          : await this.#db
              .select({ id: jobs.id, job: jobs.job })
              .from(jobs)
              .where(inArray(jobs.id, staleIds));
      for (const row of freshRows) {
        const version = versionById.get(row.id);
        if (version === undefined) continue;
        const parsed = jobSchema.safeParse(row.job);
        this.#cache.set(
          row.id,
          parsed.success
            ? { version, ok: true, job: deepFreeze(parsed.data) }
            : {
                version,
                ok: false,
                type: journalRowType(row.job),
                bytes: byteLength(row.job),
                reason: summarizeInvalidFields(parsed.error.issues),
              },
        );
      }
    }

    for (const id of [...this.#cache.keys()]) {
      if (!versionById.has(id)) this.#cache.delete(id);
    }

    const found: Job[] = [];
    const skipped: { id: string; reason: string; type: string | undefined; bytes: number }[] = [];
    for (const row of rows) {
      const entry = this.#cache.get(row.id);
      if (entry === undefined) continue;
      if (entry.ok) {
        // 凍らせた覚えの中身をそのまま返さない: 呼び出し側のトップレベルの書き換えが覚えを汚染するため。
        found.push({ ...entry.job });
      } else {
        skipped.push({ id: row.id, reason: entry.reason, type: entry.type, bytes: entry.bytes });
      }
    }
    return { found, skipped };
  }

  async putJob(job: Job): Promise<void> {
    const value = stripNulls(prepareJobForWrite(jobSchema.parse(job)));
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

  // `#cache` を手で消さない: `UPDATE` で `xmin` が進むので、次の `listJobs()` の段1が版の変化を検出するため。
  // 読めない行を `null` にしない: 呼び出し元が「台帳に居ない」と言い切るため。書き換えない: 新しい版が書いた `status` 等を古い版の `mutate` が上書きするため。
  async updateJob(id: string, mutate: (current: Job) => Job): Promise<Job | null> {
    if (hasNul(id)) return null;
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ job: jobs.job })
        .from(jobs)
        .where(eq(jobs.id, id))
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row === undefined) return null;

      const parsed = jobSchema.safeParse(row.job);
      if (!parsed.success) {
        const reason = summarizeInvalidFields(parsed.error.issues);
        process.stderr.write(`${describeUnreadableJobRow({ id, reason })}\n`);
        throw new UnreadableJobError({ id, reason });
      }
      const current = parsed.data;
      const next = stripNulls(prepareJobForWrite(jobSchema.parse(mutate(current))));

      await tx
        .update(jobs)
        .set({ status: next.status, updatedAt: new Date(next.updatedAt), job: next })
        .where(eq(jobs.id, id));

      return next;
    });
  }

  async listApprovals(
    options: { pendingOnly?: boolean; conversationId?: string } = {},
  ): Promise<ApprovalList> {
    const pendingWhere =
      options.pendingOnly === true
        ? and(isNull(approvals.answeredAt), isNull(approvals.withdrawnAt))
        : undefined;
    // 会話の絞りを JS 側でやらない: 読めない行も同じ式で絞り、一致しない行は読まない（全行の検査をしない）ため。
    // NUL を含む会話 id を DB に投げない: エラーになるため。
    const conversationId = options.conversationId;
    if (conversationId !== undefined && hasNul(conversationId)) {
      return { entries: [], unreadable: [] };
    }
    const where =
      conversationId === undefined
        ? pendingWhere
        : and(pendingWhere, sql`${CONVERSATION_ID_EXPR} = ${conversationId}`);
    const rows = await this.#db
      .select({ id: approvals.id, approval: approvals.approval })
      .from(approvals)
      .where(where)
      .orderBy(asc(approvals.createdAt));
    const entries: PendingApproval[] = [];
    const unreadable: UnreadableApproval[] = [];
    for (const row of rows) {
      const parsed = pendingApprovalSchema.safeParse(row.approval);
      if (parsed.success) {
        entries.push(parsed.data);
        continue;
      }
      const reason = summarizeInvalidFields(parsed.error.issues);
      process.stderr.write(
        `${describeUnreadableApprovalRow({ op: 'listApprovals', id: row.id, reason })}\n`,
      );
      unreadable.push({ id: row.id, reason });
    }
    return { entries, unreadable };
  }

  async getApproval(id: string): Promise<PendingApproval | null> {
    if (hasNul(id)) return null;
    const rows = await this.#db
      .select({ approval: approvals.approval })
      .from(approvals)
      .where(eq(approvals.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = pendingApprovalSchema.safeParse(row.approval);
    if (!parsed.success) {
      const reason = summarizeInvalidFields(parsed.error.issues);
      process.stderr.write(`${describeUnreadableApprovalRow({ op: 'getApproval', id, reason })}\n`);
      throw new UnreadableApprovalError({ id, reason });
    }
    return parsed.data;
  }

  async putApproval(rawApproval: PendingApproval): Promise<void> {
    const approval = prepareApprovalForWrite(rawApproval);
    const value = stripNulls(pendingApprovalSchema.parse(approval));
    const answeredAt = value.answeredAt === undefined ? null : new Date(value.answeredAt);
    const withdrawnAt = value.withdrawnAt === undefined ? null : new Date(value.withdrawnAt);
    await this.#db
      .insert(approvals)
      .values({
        id: value.id,
        createdAt: new Date(value.createdAt),
        answeredAt,
        withdrawnAt,
        approval: value,
      })
      .onConflictDoUpdate({
        target: approvals.id,
        set: { answeredAt, withdrawnAt, approval: value },
      });
  }

  async updateApproval(
    id: string,
    mutate: (current: PendingApproval) => PendingApproval | null,
  ): Promise<PendingApproval | null> {
    if (hasNul(id)) return null;
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ approval: approvals.approval })
        .from(approvals)
        .where(eq(approvals.id, id))
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row === undefined) return null;
      const parsed = pendingApprovalSchema.safeParse(row.approval);
      if (!parsed.success) {
        const reason = summarizeInvalidFields(parsed.error.issues);
        process.stderr.write(
          `${describeUnreadableApprovalRow({ op: 'updateApproval', id, reason })}\n`,
        );
        throw new UnreadableApprovalError({ id, reason });
      }

      const result = mutate(parsed.data);
      if (result === null) return null;
      const next = stripNulls(prepareApprovalForWrite(pendingApprovalSchema.parse(result)));
      const answeredAt = next.answeredAt === undefined ? null : new Date(next.answeredAt);
      const withdrawnAt = next.withdrawnAt === undefined ? null : new Date(next.withdrawnAt);

      await tx
        .update(approvals)
        .set({ answeredAt, withdrawnAt, approval: next })
        .where(eq(approvals.id, id));

      return next;
    });
  }

  // `#cache` を直接触らない: 次の `listJobs()` が段1からやり直し、古い entry を自然に捨てるため。
  async clear(): Promise<{ jobs: number; approvals: number }> {
    return this.#db.transaction(async (tx) => {
      const removedJobs = await tx.delete(jobs).returning({ id: jobs.id });
      const removedApprovals = await tx.delete(approvals).returning({ id: approvals.id });
      return { jobs: removedJobs.length, approvals: removedApprovals.length };
    });
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  jobSchema,
  prepareApprovalForWrite,
  prepareJobForWrite,
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
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

// 行の中身はここで検査しない: `z.array(jobSchema)` / `z.array(pendingApprovalSchema)` にすると、1行の不正が配列全体を道連れにするため
const fileSchema = z.object({
  jobs: z.array(z.unknown()).default([]),
  approvals: z.array(z.unknown()).default([]),
});

interface JobFile {
  jobs: Job[];
  // 消さずに持ち回る: 書き戻しに入れないと、次の書き込みで消えるため
  invalidJobsRaw: unknown[];
  approvals: PendingApproval[];
  invalidApprovalsRaw: unknown[];
}

const EMPTY: JobFile = { jobs: [], invalidJobsRaw: [], approvals: [], invalidApprovalsRaw: [] };

// `issue.message` は使わない: zod の既定メッセージが将来 `received`（実際の値）を含む形に変わると値が漏れるため
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

function extractRowId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

function isSettledRaw(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const row = raw as Record<string, unknown>;
  const set = (v: unknown): boolean => v !== undefined && v !== null;
  return set(row.answeredAt) || set(row.withdrawnAt);
}

function rawConversationId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = (raw as Record<string, unknown>).conversationId;
  return typeof value === 'string' ? value : undefined;
}

function summarizeRawApprovalProblem(raw: unknown): string {
  const result = pendingApprovalSchema.safeParse(raw);
  return result.success ? '不正な行' : summarizeInvalidFields(result.error.issues);
}

function summarizeRawJobProblem(raw: unknown): string {
  const result = jobSchema.safeParse(raw);
  return result.success ? '不正な行' : summarizeInvalidFields(result.error.issues);
}

// id 以外の値は載せない: job の欄には人間の依頼文・マネージャーの報告がそのまま入りうるため
function describeSkippedJobRow(params: { index: number; reason: string; id?: string }): string {
  const idNote = params.id === undefined ? '' : ` id=${JSON.stringify(params.id)}`;
  return (
    `alteroid: jobs の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${idNote}`
  );
}

// id 以外の値は載せない: `question` / `context` には人間の依頼文がそのまま入りうるため
function describeSkippedApprovalRow(params: {
  index: number;
  reason: string;
  id?: string;
}): string {
  const idNote = params.id === undefined ? '' : ` id=${JSON.stringify(params.id)}`;
  return (
    `alteroid: approvals の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${idNote}`
  );
}

export class FsJobStore implements JobStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'jobs.json');
  }

  async listJobs(): Promise<Job[]> {
    return (await this.#read()).jobs;
  }

  async listUnreadableJobs(): Promise<UnreadableJob[]> {
    const { invalidJobsRaw } = await this.#read();
    return invalidJobsRaw.map((raw): UnreadableJob => {
      const id = extractRowId(raw);
      const reason = summarizeRawJobProblem(raw);
      return id === undefined ? { reason } : { id, reason };
    });
  }

  async putJob(rawJob: Job): Promise<void> {
    const job = prepareJobForWrite(rawJob);
    await this.#update((file) => {
      const jobs = file.jobs.filter((existing) => existing.id !== job.id);
      jobs.push(jobSchema.parse(job));
      // 書き込む id と一致する壊れた行は置き換える: 残すと同じ id が2行並び、`listJobs()` のたびに直したはずの跡が出続けるため
      const invalidJobsRaw = file.invalidJobsRaw.filter((raw) => extractRowId(raw) !== job.id);
      return { ...file, jobs, invalidJobsRaw };
    });
  }

  async updateJob(id: string, mutate: (current: Job) => Job): Promise<Job | null> {
    return withPathLock(this.#path, async () => {
      const file = await this.#read();
      const found = file.jobs.find((entry) => entry.id === id);
      if (found === undefined) {
        // 読めない行にしか無い id は `null` にせず投げる: 「読めない」を「無い」へ倒すと、呼び出し元が「台帳に居ない」と言い切るため
        if (file.invalidJobsRaw.some((raw) => extractRowId(raw) === id)) {
          throw new UnreadableJobError({ id });
        }
        return null;
      }
      // `mutate` に await を挟ませない: 区間の外へ出ると排他の意味が崩れるため
      const next = prepareJobForWrite(jobSchema.parse(mutate(found)));
      const jobs = file.jobs.map((entry) => (entry.id === id ? next : entry));
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(
        this.#path,
        `${JSON.stringify(this.#serialize({ ...file, jobs }), null, 2)}\n`,
      );
      return next;
    });
  }

  async listApprovals(
    options: { pendingOnly?: boolean; conversationId?: string } = {},
  ): Promise<ApprovalList> {
    const { approvals, invalidApprovalsRaw } = await this.#read();
    const pending = options.pendingOnly
      ? approvals.filter((a) => a.answeredAt === undefined && a.withdrawnAt === undefined)
      : approvals;
    const entries =
      options.conversationId === undefined
        ? pending
        : pending.filter((a) => a.conversationId === options.conversationId);
    const unreadable = invalidApprovalsRaw
      .filter((raw) => options.pendingOnly !== true || !isSettledRaw(raw))
      .filter(
        (raw) =>
          options.conversationId === undefined || rawConversationId(raw) === options.conversationId,
      )
      .map((raw): UnreadableApproval => {
        const id = extractRowId(raw);
        const reason = summarizeRawApprovalProblem(raw);
        return id === undefined ? { reason } : { id, reason };
      });
    return { entries, unreadable };
  }

  async getApproval(id: string): Promise<PendingApproval | null> {
    const { approvals, invalidApprovalsRaw } = await this.#read();
    const found = approvals.find((approval) => approval.id === id);
    if (found !== undefined) return found;
    if (invalidApprovalsRaw.some((raw) => extractRowId(raw) === id)) {
      throw new UnreadableApprovalError({ id });
    }
    return null;
  }

  async putApproval(rawApproval: PendingApproval): Promise<void> {
    const approval = prepareApprovalForWrite(rawApproval);
    await this.#update((file) => {
      const approvals = file.approvals.filter((existing) => existing.id !== approval.id);
      approvals.push(pendingApprovalSchema.parse(approval));
      // 書き込む id と一致する壊れた行は置き換える: 残すと同じ id が2行並び、`listApprovals()` のたびに直したはずの跡が出続けるため
      const invalidApprovalsRaw = file.invalidApprovalsRaw.filter(
        (raw) => extractRowId(raw) !== approval.id,
      );
      return { ...file, approvals, invalidApprovalsRaw };
    });
  }

  async updateApproval(
    id: string,
    mutate: (current: PendingApproval) => PendingApproval | null,
  ): Promise<PendingApproval | null> {
    return withPathLock(this.#path, async () => {
      const file = await this.#read();
      const found = file.approvals.find((entry) => entry.id === id);
      if (found === undefined) {
        // 読めない行にしか無い id は `null` にせず投げる: 「読めない」を「無い」へ倒すと、呼び出し元が「台帳に居ない」と言い切るため
        if (file.invalidApprovalsRaw.some((raw) => extractRowId(raw) === id)) {
          throw new UnreadableApprovalError({ id });
        }
        return null;
      }
      // `mutate` に await を挟ませない: 区間の外へ出ると排他の意味が崩れるため
      const result = mutate(found);
      if (result === null) return null;
      const next = prepareApprovalForWrite(pendingApprovalSchema.parse(result));
      const approvals = file.approvals.map((entry) => (entry.id === id ? next : entry));
      const invalidApprovalsRaw = file.invalidApprovalsRaw.filter(
        (raw) => extractRowId(raw) !== id,
      );
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(
        this.#path,
        `${JSON.stringify(this.#serialize({ ...file, approvals, invalidApprovalsRaw }), null, 2)}\n`,
      );
      return next;
    });
  }

  async clear(): Promise<{ jobs: number; approvals: number }> {
    let removed = { jobs: 0, approvals: 0 };
    await this.#update((file) => {
      // 壊れた行も一緒に消して件数に数える: 全消去なので、fs だけ壊れた行が残ると実装ごとに意味が変わり、`POST /reset` の件数も実際より少なく出るため
      removed = {
        jobs: file.jobs.length + file.invalidJobsRaw.length,
        approvals: file.approvals.length + file.invalidApprovalsRaw.length,
      };
      return { jobs: [], invalidJobsRaw: [], approvals: [], invalidApprovalsRaw: [] };
    });
    return removed;
  }

  async #read(): Promise<JobFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const top = fileSchema.parse(JSON.parse(raw));
      const jobs: Job[] = [];
      const invalidJobsRaw: unknown[] = [];
      top.jobs.forEach((rawJob, index) => {
        const result = jobSchema.safeParse(rawJob);
        if (result.success) {
          jobs.push(result.data);
          return;
        }
        invalidJobsRaw.push(rawJob);
        process.stderr.write(
          `${describeSkippedJobRow({
            index,
            reason: summarizeInvalidFields(result.error.issues),
            id: extractRowId(rawJob),
          })}\n`,
        );
      });
      const approvals: PendingApproval[] = [];
      const invalidApprovalsRaw: unknown[] = [];
      top.approvals.forEach((rawApproval, index) => {
        const result = pendingApprovalSchema.safeParse(rawApproval);
        if (result.success) {
          approvals.push(result.data);
          return;
        }
        invalidApprovalsRaw.push(rawApproval);
        process.stderr.write(
          `${describeSkippedApprovalRow({
            index,
            reason: summarizeInvalidFields(result.error.issues),
            id: extractRowId(rawApproval),
          })}\n`,
        );
      });
      return { jobs, invalidJobsRaw, approvals, invalidApprovalsRaw };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
  }

  // 1本の配列へ合流させる: 分けたまま書くと、次の `#read()` で未知のキーとして黙って捨てられるため
  #serialize(file: JobFile): { jobs: unknown[]; approvals: unknown[] } {
    return {
      jobs: [...file.jobs, ...file.invalidJobsRaw],
      approvals: [...file.approvals, ...file.invalidApprovalsRaw],
    };
  }

  async #update(mutate: (file: JobFile) => JobFile): Promise<void> {
    await withPathLock(this.#path, async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(this.#serialize(next), null, 2)}\n`);
    });
  }
}

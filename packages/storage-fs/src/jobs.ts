import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { jobSchema, pendingApprovalSchema } from '@alteroid/core';
import type { Job, JobStore, PendingApproval } from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const fileSchema = z.object({
  jobs: z.array(jobSchema).default([]),
  approvals: z.array(pendingApprovalSchema).default([]),
});

type JobFile = z.infer<typeof fileSchema>;

/**
 * ジョブと承認待ちキュー = 1枚の JSON。
 *
 * M1 で使うのは承認待ちだけ（`ask_human` の行き先）。ジョブ本体は M2 で
 * manager_id と SDK session_id の対応を持つ器になる。
 */
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

  async putJob(job: Job): Promise<void> {
    await this.#update((file) => {
      const jobs = file.jobs.filter((existing) => existing.id !== job.id);
      jobs.push(jobSchema.parse(job));
      return { ...file, jobs };
    });
  }

  /**
   * 現在の値を排他区間（`withPathLock`）の中で読み直し、`mutate` で書き換えて
   * 書く（Issue #1674。`JobStore.updateJob` の doc）。**現在値を読むのも書くのも
   * 同じロックの区間の中**——`schedules.ts` の `editRequest` と同じ形。ここは
   * `#update`（戻り値を持たない）を共有せず独立させてある——`#update` は
   * `putApproval` / `clear`（担当が別）も使っているので、戻り値の形を変える
   * ために触ると、この変更の範囲が承認待ちキューの実装にまで広がってしまう。
   */
  async updateJob(id: string, mutate: (current: Job) => Job): Promise<Job | null> {
    return withPathLock(this.#path, async () => {
      const file = await this.#read();
      const found = file.jobs.find((entry) => entry.id === id);
      if (found === undefined) return null;
      // 同期のまま最後まで書き換える（`mutate` に await を挟ませない——区間の
      // 外へ出ると排他の意味が崩れる。`CommitmentStore.open` の同じ注意）。
      const next = jobSchema.parse(mutate(found));
      const jobs = file.jobs.map((entry) => (entry.id === id ? next : entry));
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify({ ...file, jobs }, null, 2)}\n`);
      return next;
    });
  }

  async listApprovals(options: { pendingOnly?: boolean } = {}): Promise<PendingApproval[]> {
    const { approvals } = await this.#read();
    // **未回答かつ未取り下げだけを「保留」とする（#963）。** 取り下げも
    // `answeredAt` と同じく「もう保留ではない」終端の一形態である
    // （`pendingApprovalSchema.withdrawnAt` の doc）。
    return options.pendingOnly
      ? approvals.filter((a) => a.answeredAt === undefined && a.withdrawnAt === undefined)
      : approvals;
  }

  async getApproval(id: string): Promise<PendingApproval | null> {
    const { approvals } = await this.#read();
    return approvals.find((approval) => approval.id === id) ?? null;
  }

  async putApproval(approval: PendingApproval): Promise<void> {
    await this.#update((file) => {
      const approvals = file.approvals.filter((existing) => existing.id !== approval.id);
      approvals.push(pendingApprovalSchema.parse(approval));
      return { ...file, approvals };
    });
  }

  /** ジョブと承認待ちを両方消す（`JobStore.clear` の doc）。 */
  async clear(): Promise<{ jobs: number; approvals: number }> {
    let removed = { jobs: 0, approvals: 0 };
    await this.#update((file) => {
      removed = { jobs: file.jobs.length, approvals: file.approvals.length };
      return { jobs: [], approvals: [] };
    });
    return removed;
  }

  async #read(): Promise<JobFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { jobs: [], approvals: [] };
      throw error;
    }
  }

  /**
   * read-modify-write を直列化する（issue #1113 / #1050 — `withPathLock` で
   * プロセス内・プロセス間の両方を排他する。advisory の強さは `file-lock.ts`
   * の doc を見よ）。
   */
  async #update(mutate: (file: JobFile) => JobFile): Promise<void> {
    await withPathLock(this.#path, async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`);
    });
  }
}

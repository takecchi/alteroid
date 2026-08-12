import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { jobSchema, pendingApprovalSchema } from '@alteroid/core';
import type { Job, JobStore, PendingApproval } from '@alteroid/core';
import { z } from 'zod';

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
  #chain: Promise<unknown> = Promise.resolve();

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

  async listApprovals(options: { pendingOnly?: boolean } = {}): Promise<PendingApproval[]> {
    const { approvals } = await this.#read();
    return options.pendingOnly ? approvals.filter((a) => a.answeredAt === undefined) : approvals;
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

  async #read(): Promise<JobFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { jobs: [], approvals: [] };
      throw error;
    }
  }

  /** read-modify-write を直列化する（デーモン1プロセス前提の最小の排他）。 */
  async #update(mutate: (file: JobFile) => JobFile): Promise<void> {
    const run = this.#chain.then(async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(tmp, this.#path);
    });
    this.#chain = run.catch(() => undefined);
    await run;
  }
}

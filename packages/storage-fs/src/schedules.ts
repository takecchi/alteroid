import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { scheduledRequestSchema } from '@alteroid/core';
import type { ScheduleStore, ScheduledRequest } from '@alteroid/core';
import { z } from 'zod';

const fileSchema = z.object({
  schedules: z.array(scheduledRequestSchema).default([]),
});

type ScheduleFile = z.infer<typeof fileSchema>;

/**
 * 継続中の依頼 = 1枚の JSON。
 *
 * ジョブ台帳と同じディレクトリに置く。**人間が開いて読めること**を保つ形にしておく
 * （自分が出した「これからずっと」の依頼が見えないのは可観測性の穴になる）。
 */
export class FsScheduleStore implements ScheduleStore {
  readonly #dir: string;
  readonly #path: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'schedules.json');
  }

  async list(): Promise<ScheduledRequest[]> {
    return [...(await this.#read()).schedules].sort((a, b) => a.kind.localeCompare(b.kind));
  }

  async get(kind: string): Promise<ScheduledRequest | null> {
    return (await this.#read()).schedules.find((entry) => entry.kind === kind) ?? null;
  }

  async put(entry: ScheduledRequest): Promise<void> {
    await this.#update((file) => ({
      schedules: [
        ...file.schedules.filter((existing) => existing.kind !== entry.kind),
        scheduledRequestSchema.parse(entry),
      ],
    }));
  }

  async remove(kind: string): Promise<void> {
    await this.#update((file) => ({
      schedules: file.schedules.filter((existing) => existing.kind !== kind),
    }));
  }

  async markRun(kind: string, at: string): Promise<void> {
    await this.#update((file) => ({
      schedules: file.schedules.map((existing) =>
        existing.kind === kind ? { ...existing, lastRunAt: at, updatedAt: at } : existing,
      ),
    }));
  }

  async #read(): Promise<ScheduleFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schedules: [] };
      throw error;
    }
  }

  /** read-modify-write を直列化する（デーモン1プロセス前提の最小の排他）。 */
  async #update(mutate: (file: ScheduleFile) => ScheduleFile): Promise<void> {
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

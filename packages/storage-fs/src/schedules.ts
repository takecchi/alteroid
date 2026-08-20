import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { schedulePhaseSchema, scheduledRequestSchema } from '@alteroid/core';
import type { SchedulePhase, ScheduleStore, ScheduledRequest } from '@alteroid/core';
import { z } from 'zod';

const fileSchema = z.object({
  schedules: z.array(scheduledRequestSchema).default([]),
  /**
   * 既定の仕込み（日報・発意 tick）の位相。**依頼ではない**ので `list()` には出ない。
   *
   * 同じファイルに置いてあるのは、`#update` の排他区間を1本に保つためである
   * （別ファイルにすると鎖が2本になり、片方だけ直列化されている状態が生まれる）。
   * 既定 `[]` なので、この列が無い古いファイルもそのまま読める。
   */
  phases: z.array(schedulePhaseSchema).default([]),
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
    // **`...file` を落とさないこと。** 同じファイルに位相も入っているので、
    // 書き換える列だけを差し替える（`{ schedules: ... }` だけを返すと位相が消える）。
    await this.#update((file) => ({
      next: {
        ...file,
        schedules: [
          ...file.schedules.filter((existing) => existing.kind !== entry.kind),
          scheduledRequestSchema.parse(entry),
        ],
      },
      result: undefined,
    }));
  }

  async remove(kind: string): Promise<void> {
    await this.#update((file) => ({
      next: { ...file, schedules: file.schedules.filter((existing) => existing.kind !== kind) },
      result: undefined,
    }));
  }

  async getPhase(kind: string): Promise<SchedulePhase | null> {
    return (await this.#read()).phases.find((phase) => phase.kind === kind) ?? null;
  }

  async putPhase(phase: SchedulePhase): Promise<void> {
    await this.#update((file) => ({
      next: {
        ...file,
        phases: [
          ...file.phases.filter((existing) => existing.kind !== phase.kind),
          schedulePhaseSchema.parse(phase),
        ],
      },
      result: undefined,
    }));
  }

  /**
   * 発火の確定。**読みと記録を同じ排他区間で行う**（隙間に remove / put を挟ませない）。
   *
   * **`updatedAt` は動かさない** — あれは「依頼が最後に書き換えられた時刻」であり、
   * 発火で上書きすると人間が「この依頼いつ直したか」を追えなくなる。同時に、これが
   * 版の識別子でもある（動かすと版の比較そのものが壊れる）。
   */
  async claimRun(
    kind: string,
    expectedUpdatedAt: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<ScheduledRequest | null> {
    return this.#update((file) => {
      const found = file.schedules.find((entry) => entry.kind === kind);
      // 消された・書き換わった。**古い本文で動かさないために null を返す。**
      if (found === undefined || found.updatedAt !== expectedUpdatedAt) {
        return { next: file, result: null };
      }
      return {
        next: {
          ...file,
          schedules: file.schedules.map((entry) =>
            entry.kind === kind
              ? // 引き受けた印と観測用の時刻だけ。定期の基準は `completeRun` で進める
                { ...entry, lastRunAt: at, pendingRun: { at, cause } }
              : entry,
          ),
        },
        // 返すのは更新前の姿（呼び出し側は「前回いつ動いたか」と、前の発火が
        // 終わっていたかを材料に要る）
        result: found,
      };
    });
  }

  async completeRun(kind: string, at: string, cause: 'schedule' | 'manual'): Promise<void> {
    await this.#update((file) => ({
      next: {
        ...file,
        schedules: file.schedules.map((entry) => {
          // 別の発火の印が付いているなら触らない（後から来た発火のものを消さない）
          if (entry.kind !== kind || entry.pendingRun?.at !== at) return entry;
          const rest = { ...entry };
          delete rest.pendingRun;
          // 手で起こした1回では定期の予定をずらさない
          return cause === 'schedule' ? { ...rest, lastScheduledRunAt: at } : rest;
        }),
      },
      result: undefined,
    }));
  }

  async #read(): Promise<ScheduleFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schedules: [], phases: [] };
      throw error;
    }
  }

  /**
   * read-modify-write を直列化する（デーモン1プロセス前提の最小の排他）。
   *
   * `mutate` は書き込む内容と、呼び出し側へ返す値の両方を決める。**読んだ結果に
   * 基づいて書くかどうかを決める操作**（`claimRun`）を、この区間の外へ出さないこと。
   */
  async #update<T>(mutate: (file: ScheduleFile) => { next: ScheduleFile; result: T }): Promise<T> {
    const run = this.#chain.then(async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(tmp, this.#path);
      return result;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { inboxEventSchema } from '@alteroid/core';
import type { InboxEvent, InboxStore, PendingInboxEvent } from '@alteroid/core';
import { z } from 'zod';

const inboxEntrySchema = z.object({
  event: inboxEventSchema,
  /** `post` が受理した時刻（ISO 8601）。 */
  at: z.string(),
  deliveries: z.number().int().nonnegative(),
});

const fileSchema = z.object({
  events: z.array(inboxEntrySchema).default([]),
});

type InboxFile = z.infer<typeof fileSchema>;

/**
 * まだ処理し終えていない受信箱の合図 = 1枚の JSON（`store.ts` の `InboxStore`）。
 *
 * ジョブ台帳・継続中の依頼（`FsScheduleStore`）と同じディレクトリに置き、同じ作法
 * （`#chain` による直列化、`rename` による原子的な書き込み）を踏襲する。
 */
export class FsInboxStore implements InboxStore {
  readonly #dir: string;
  readonly #path: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'inbox.json');
  }

  async put(event: InboxEvent, at: string): Promise<void> {
    const value = inboxEventSchema.parse(event);
    await this.#update((file) => {
      // 同じ id があれば配達回数を引き継ぐ（無ければ初回＝0）。
      const existing = file.events.find((entry) => entry.event.id === value.id);
      return {
        next: {
          events: [
            ...file.events.filter((entry) => entry.event.id !== value.id),
            { event: value, at, deliveries: existing?.deliveries ?? 0 },
          ],
        },
        result: undefined,
      };
    });
  }

  async remove(id: string): Promise<void> {
    await this.#update((file) => ({
      next: { events: file.events.filter((entry) => entry.event.id !== id) },
      result: undefined,
    }));
  }

  /**
   * 残っている未読を古い順に返し、**同時に配達回数を1つ進める**。
   *
   * `ScheduleStore.claimRun` と同じ作法で、読みと書きを `#update` の1区間へ閉じる
   * （`#chain` による直列化がそのまま排他になる）。返す `deliveries` は進めた後の値。
   */
  async claimPending(): Promise<PendingInboxEvent[]> {
    return this.#update((file) => {
      const sorted = [...file.events].sort((a, b) => a.at.localeCompare(b.at));
      const claimed = sorted.map((entry) => ({ ...entry, deliveries: entry.deliveries + 1 }));
      return {
        next: { events: claimed },
        result: claimed.map((entry) => ({
          event: entry.event,
          at: entry.at,
          deliveries: entry.deliveries,
        })),
      };
    });
  }

  /**
   * 残っている未読の件数と、いちばん古いものが積まれた時刻（#358）。
   * **`claimPending` と違い、読むだけで書かない** — `#update` を通さない
   * ので `deliveries` は1つも進まない。
   */
  async pending(): Promise<{ count: number; oldestAt?: string }> {
    const file = await this.#read();
    const oldest = file.events.reduce<string | undefined>(
      (min, entry) => (min === undefined || entry.at < min ? entry.at : min),
      undefined,
    );
    return {
      count: file.events.length,
      ...(oldest === undefined ? {} : { oldestAt: oldest }),
    };
  }

  async #read(): Promise<InboxFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [] };
      throw error;
    }
  }

  /**
   * read-modify-write を直列化する（`FsScheduleStore#update` と同じ最小の排他）。
   *
   * `mutate` は書き込む内容と、呼び出し側へ返す値の両方を決める。**読んだ結果に
   * 基づいて書くかどうか・何を進めるかを決める操作**（`claimPending`）を、この
   * 区間の外へ出さないこと。
   */
  async #update<T>(mutate: (file: InboxFile) => { next: InboxFile; result: T }): Promise<T> {
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

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { inboxEventSchema } from '@alteroid/core';
import type { InboxEvent, InboxStore, PendingInboxEvent } from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

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
 * （`withPathLock` による直列化、`writeFileAtomic` による原子的な書き込み）を
 * 踏襲する。
 */
export class FsInboxStore implements InboxStore {
  readonly #dir: string;
  readonly #path: string;

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
   * （`withPathLock` による排他がそのまま効く）。返す `deliveries` は進めた後の値。
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

  /**
   * 残っている未読を古い順に返す。**`claimPending` と違い、`#update` を
   * 通さない — 1文字も書かない**（`InboxStore.peekPending` の doc）。
   */
  async peekPending(): Promise<PendingInboxEvent[]> {
    const file = await this.#read();
    return [...file.events]
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((entry) => ({ event: entry.event, at: entry.at, deliveries: entry.deliveries }));
  }

  /**
   * 絞り込みで選んだ複数件をまとめて消す（`InboxStore.removeMany` の doc、
   * issue #972）。
   *
   * `FsCommitmentStore.closeMany` と同じ筋——`#update` の排他区間を1回だけ
   * 使い、対象の行を全部その中で処理する。`remove()` を `ids` の件数だけ
   * 呼ぶ形（＝ `#update` を件数分呼ぶ形）にしないのがこのメソッドの存在
   * 理由そのもの（`InboxStore.removeMany` の doc）。
   *
   * `ids` を `Set` にしてから見るので、重複があっても対象の判定は変わらない
   * ——同じ行が複数回消えることも、戻り値に同じ id が複数回入ることも無い。
   *
   * `ids` が空なら `#update` を呼ばずに `[]` を返す（`FsCommitmentStore
   * .closeMany` と同じ理由——ファイルの中身が1バイトも変わらない）。
   */
  async removeMany(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const targets = new Set(ids);
    return this.#update((file) => {
      const removedIds: string[] = [];
      const events = file.events.filter((entry) => {
        if (!targets.has(entry.event.id)) return true;
        removedIds.push(entry.event.id);
        return false;
      });
      return { next: { events }, result: removedIds };
    });
  }

  /** 全件を消す（`InboxStore.clear` の doc）。 */
  async clear(): Promise<number> {
    return this.#update((file) => ({ next: { events: [] }, result: file.events.length }));
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
   * read-modify-write を直列化する（`FsScheduleStore#update` と同じ `withPathLock`
   * ベースの排他。issue #1113 / #1050）。
   *
   * `mutate` は書き込む内容と、呼び出し側へ返す値の両方を決める。**読んだ結果に
   * 基づいて書くかどうか・何を進めるかを決める操作**（`claimPending`）を、この
   * 区間の外へ出さないこと。
   */
  async #update<T>(mutate: (file: InboxFile) => { next: InboxFile; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`);
      return result;
    });
  }
}

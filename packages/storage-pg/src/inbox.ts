import { inboxEventSchema } from '@alteroid/core';
import type { InboxEvent, InboxStore, PendingInboxEvent } from '@alteroid/core';
import { eq, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso } from './db.js';
import { inboxEvents } from './schema.js';

/**
 * 行が読めなければ落とさずに投げる（`PgScheduleStore` の `parsePlan` と同じ理由）。
 *
 * 受信箱の合図は「まだ処理し終えていない」という事実そのものであって、日誌のように
 * 1件壊れても一覧が成立する記録ではない。読めない行を黙って飛ばすと、二度と配られ
 * ない合図が「処理済みで消えた」ものと区別できなくなる。
 */
function parseEvent(id: string, value: unknown): InboxEvent {
  const parsed = inboxEventSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    `受信箱の合図 ${id} が読めない形で入っている（消されたのではない）: ${parsed.error.message}`,
  );
}

/**
 * まだ処理し終えていない受信箱の合図（PostgreSQL）。fs 版（`FsInboxStore`）と同じ IF
 * を満たす別の器であって、能力の差を作らない（`store.ts`「省略可能にしないこと」）。
 */
export class PgInboxStore implements InboxStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async put(event: InboxEvent, at: string): Promise<void> {
    // 本文は人間の発言・webhook 由来もあるので NUL が混ざりうる（`db.ts` 参照）。
    const value = stripNulls(inboxEventSchema.parse(event));
    await this.#db
      .insert(inboxEvents)
      .values({ id: value.id, event: value, at: new Date(at), deliveries: 0 })
      .onConflictDoUpdate({
        target: inboxEvents.id,
        // deliveries はここに含めない = 上書きされない（配達回数を保つ）。
        set: { event: value, at: new Date(at) },
      });
  }

  async remove(id: string): Promise<void> {
    await this.#db.delete(inboxEvents).where(eq(inboxEvents.id, id));
  }

  /**
   * 残っている未読を古い順に返し、**同時に配達回数を1つ進める**。
   *
   * `UPDATE ... RETURNING` の1発で書く（`PgScheduleStore.claimRun` のような
   * トランザクションを挟むまでもない — 単一の SQL 文自体が PostgreSQL では
   * 不可分であり、これで読みと書きを1操作に閉じる、という条件を満たす）。
   */
  async claimPending(): Promise<PendingInboxEvent[]> {
    const rows = await this.#db
      .update(inboxEvents)
      .set({ deliveries: sql`${inboxEvents.deliveries} + 1` })
      .returning();

    return (
      rows
        .map((row) => ({
          event: parseEvent(row.id, row.event),
          at: row.at,
          deliveries: row.deliveries,
        }))
        // 古い順。`at` は timestamptz なので Date 同士で比べる（文字列表現の揺れに
        // 依らない）。
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .map((entry) => ({ event: entry.event, at: toIso(entry.at), deliveries: entry.deliveries }))
    );
  }
}

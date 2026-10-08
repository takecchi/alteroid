import { inboxEventSchema } from '@alteroid/core';
import type {
  InboxEvent,
  InboxPeek,
  InboxStore,
  PendingInboxEvent,
  UnreadableInboxEvent,
} from '@alteroid/core';
import { asc, eq, inArray, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso } from './db.js';
import { inboxEvents } from './schema.js';

// 読めない行を黙って飛ばさず、行も消さない: 二度と配られない合図が「処理済みで消えた」ものと区別できなくなるため。
// 投げもしない: 1行の不良が `claimPending` を止め、ほかの正しい未読まで配られなくなるため。
function parseEventOrReason(
  id: string,
  value: unknown,
): { event: InboxEvent } | { reason: string } {
  const parsed = inboxEventSchema.safeParse(value);
  if (parsed.success) return { event: parsed.data };
  const fields = [
    ...new Set(
      parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
      ),
    ),
  ];
  process.stderr.write(
    `alteroid: 受信箱の読めない合図を配る側から外しました（id=${JSON.stringify(id)}、不正な欄: ${fields.join(',')}。行は消していない）\n`,
  );
  // `event.` を前置する: fs 版は行ごと検査して欄名が `event.type` の形になるので、同じ壊れ方が同じ `reason` になるようにそろえる。
  const named = fields.map((field) => (field === '(root)' ? 'event' : `event.${field}`));
  return { reason: `不正な欄: ${named.join(',')}` };
}

function parseEvent(id: string, value: unknown): InboxEvent | undefined {
  const result = parseEventOrReason(id, value);
  return 'event' in result ? result.event : undefined;
}

// 文字列で比べない: 文字列表現の揺れに依らないよう Date 同士で比べる。seq が null（migrate 前の行）は最後。
function byAtThenSeq(
  a: { at: Date; seq: number | null },
  b: { at: Date; seq: number | null },
): number {
  const seqA = a.seq ?? Number.POSITIVE_INFINITY;
  const seqB = b.seq ?? Number.POSITIVE_INFINITY;
  return a.at.getTime() - b.at.getTime() || (seqA === seqB ? 0 : seqA < seqB ? -1 : 1);
}

export class PgInboxStore implements InboxStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async put(event: InboxEvent, at: string): Promise<void> {
    const value = stripNulls(inboxEventSchema.parse(event));
    await this.#db
      .insert(inboxEvents)
      .values({ id: value.id, event: value, at: new Date(at), deliveries: 0 })
      .onConflictDoUpdate({
        target: inboxEvents.id,
        // deliveries を含めない: 上書きすると配達回数が失われるため。
        // seq を取り直す: 再 put は末尾へ回すため（fs・in-memory と同じ）。
        set: { event: value, at: new Date(at), seq: sql`nextval('inbox_events_seq_seq')` },
      });
  }

  async remove(id: string): Promise<void> {
    await this.#db.delete(inboxEvents).where(eq(inboxEvents.id, id));
  }

  // トランザクションを挟まない: 単一の `UPDATE ... RETURNING` が不可分で、読みと書きが1操作に閉じるため。
  async claimPending(): Promise<PendingInboxEvent[]> {
    const rows = await this.#db
      .update(inboxEvents)
      .set({ deliveries: sql`${inboxEvents.deliveries} + 1` })
      .returning();

    return (
      rows
        .flatMap((row) => {
          const event = parseEvent(row.id, row.event);
          return event === undefined
            ? []
            : [{ event, at: row.at, deliveries: row.deliveries, seq: row.seq }];
        })
        // RETURNING は並びを持たないので、ここで (at, seq) に並べる。
        .sort(byAtThenSeq)
        .map((entry) => ({ event: entry.event, at: toIso(entry.at), deliveries: entry.deliveries }))
    );
  }

  // `UPDATE` を含めない: 読むだけで配達回数を進めないため。
  async pending(): Promise<{ count: number; oldestAt?: string }> {
    const [row] = await this.#db
      .select({
        count: sql<number>`count(*)::int`,
        oldestAt: sql<Date | null>`min(${inboxEvents.at})`,
      })
      .from(inboxEvents);
    const count = row?.count ?? 0;
    const oldestAt = row?.oldestAt;
    return {
      count,
      ...(oldestAt === null || oldestAt === undefined ? {} : { oldestAt: toIso(oldestAt) }),
    };
  }

  // `UPDATE` を含めない: 読むだけで配達回数を進めないため。
  async peekPending(): Promise<InboxPeek> {
    const rows = await this.#db
      .select()
      .from(inboxEvents)
      .orderBy(asc(inboxEvents.at), asc(inboxEvents.seq));
    const readable: { event: InboxEvent; at: Date; deliveries: number; seq: number | null }[] = [];
    const unreadable: UnreadableInboxEvent[] = [];
    for (const row of rows) {
      const result = parseEventOrReason(row.id, row.event);
      if ('event' in result) {
        readable.push({
          event: result.event,
          at: row.at,
          deliveries: row.deliveries,
          seq: row.seq,
        });
      } else {
        unreadable.push({ id: row.id, at: toIso(row.at), reason: result.reason });
      }
    }
    return {
      entries: readable.sort(byAtThenSeq).map((entry) => ({
        event: entry.event,
        at: toIso(entry.at),
        deliveries: entry.deliveries,
      })),
      unreadable,
    };
  }

  // 空配列を `inArray` に渡さない: 方言によって挙動が割れうるため。
  async removeMany(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const removed = await this.#db
      .delete(inboxEvents)
      .where(inArray(inboxEvents.id, [...ids]))
      .returning({ id: inboxEvents.id });
    return removed.map((row) => row.id);
  }

  async clear(): Promise<number> {
    const removed = await this.#db.delete(inboxEvents).returning({ id: inboxEvents.id });
    return removed.length;
  }
}

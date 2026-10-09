import { assertEventReceiptWritable, eventReceiptCutoff, hasNul } from '@alteroid/core';
import type { EventReceipt, EventReceiptStore } from '@alteroid/core';
import { and, eq, gte, lt } from 'drizzle-orm';

import type { Db } from './db.js';
import { toIso } from './db.js';
import { eventReceipts } from './schema.js';

type Row = typeof eventReceipts.$inferSelect;

function toReceipt(row: Row): EventReceipt {
  return {
    scope: row.scope,
    source: row.source,
    idempotencyKey: row.idempotencyKey,
    eventId: row.eventId,
    at: toIso(row.at),
  };
}

// 先に入ったほうを勝たせるのは主キーの衝突に任せる: 読んでから書く形だと、同時に来た2件が両方とも「無い」を見るため
export class PgEventReceiptStore implements EventReceiptStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #sameTuple(scope: string, source: string, idempotencyKey: string) {
    return and(
      eq(eventReceipts.scope, scope),
      eq(eventReceipts.source, source),
      eq(eventReceipts.idempotencyKey, idempotencyKey),
    );
  }

  async findEventReceipt(
    scope: string,
    source: string,
    idempotencyKey: string,
    now: string,
  ): Promise<EventReceipt | null> {
    if (hasNul(scope) || hasNul(source) || hasNul(idempotencyKey)) return null;
    const rows = await this.#db
      .select()
      .from(eventReceipts)
      .where(
        and(
          this.#sameTuple(scope, source, idempotencyKey),
          gte(eventReceipts.at, new Date(eventReceiptCutoff(now))),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toReceipt(row);
  }

  async recordEventReceipt(receipt: EventReceipt): Promise<EventReceipt> {
    assertEventReceiptWritable(receipt);
    // 期限を過ぎた行を先に消す: 同じ組の古い行が主キーを塞いで、新しい行を記録できなくなるため
    await this.#db
      .delete(eventReceipts)
      .where(lt(eventReceipts.at, new Date(eventReceiptCutoff(receipt.at))));
    const inserted = await this.#db
      .insert(eventReceipts)
      .values({
        scope: receipt.scope,
        source: receipt.source,
        idempotencyKey: receipt.idempotencyKey,
        eventId: receipt.eventId,
        at: new Date(receipt.at),
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0] !== undefined) return toReceipt(inserted[0]);
    const existing = await this.#db
      .select()
      .from(eventReceipts)
      .where(this.#sameTuple(receipt.scope, receipt.source, receipt.idempotencyKey))
      .limit(1);
    if (existing[0] === undefined) {
      throw new Error('event_receipts: 衝突した行を読み直せなかった');
    }
    return toReceipt(existing[0]);
  }
}

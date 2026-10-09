import { assertEventIdempotencyInput, eventIdempotencyLimits, scopeHasNul } from '@alteroid/core';
import type {
  ClaimEventIdempotencyOutcome,
  EventIdempotencyScope,
  EventIdempotencyStore,
} from '@alteroid/core';
import { and, eq, lte } from 'drizzle-orm';

import type { Db } from './db.js';
import { eventIdempotencyKeys } from './schema.js';

export class PgEventIdempotencyStore implements EventIdempotencyStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // 単一の `insert ... on conflict do update ... where 期限切れ` で閉じる: 一意索引が並行する2本のうち1本だけを通し、期限切れの行は同じ文の中で取って代わる。
  // 負けた側（`returning` が空）だけが1件目の id を読みに行く。読むまでの間に1件目が `release` されていたら取り直す。
  async claim(
    scope: EventIdempotencyScope,
    eventId: string,
    at: string,
  ): Promise<ClaimEventIdempotencyOutcome> {
    assertEventIdempotencyInput(scope, eventId, at);
    const now = new Date(at);
    const cutoff = new Date(now.getTime() - eventIdempotencyLimits.retentionMs);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const won = await this.#db
        .insert(eventIdempotencyKeys)
        .values({ ...scope, eventId, at: now })
        .onConflictDoUpdate({
          target: [
            eventIdempotencyKeys.sender,
            eventIdempotencyKeys.source,
            eventIdempotencyKeys.key,
          ],
          set: { eventId, at: now },
          // 境界は fs・メモリと同じ: `at - retention` ちょうどの行は期限切れ。
          setWhere: lte(eventIdempotencyKeys.at, cutoff),
        })
        .returning({ eventId: eventIdempotencyKeys.eventId });
      if (won.length > 0) {
        // 期限の切れた他の行を片付ける（記録が際限なく増えないように）。失敗しても取得は成立している。
        await this.#db
          .delete(eventIdempotencyKeys)
          .where(lte(eventIdempotencyKeys.at, cutoff))
          .catch(() => undefined);
        return { status: 'claimed' };
      }
      const [existing] = await this.#db
        .select({ eventId: eventIdempotencyKeys.eventId })
        .from(eventIdempotencyKeys)
        .where(
          and(
            eq(eventIdempotencyKeys.sender, scope.sender),
            eq(eventIdempotencyKeys.source, scope.source),
            eq(eventIdempotencyKeys.key, scope.key),
          ),
        );
      if (existing !== undefined) return { status: 'duplicate', eventId: existing.eventId };
    }
    throw new Error('event idempotency: 取得が安定しなかった');
  }

  async release(scope: EventIdempotencyScope, eventId: string): Promise<void> {
    if (scopeHasNul(scope)) return;
    await this.#db
      .delete(eventIdempotencyKeys)
      .where(
        and(
          eq(eventIdempotencyKeys.sender, scope.sender),
          eq(eventIdempotencyKeys.source, scope.source),
          eq(eventIdempotencyKeys.key, scope.key),
          eq(eventIdempotencyKeys.eventId, eventId),
        ),
      );
  }
}

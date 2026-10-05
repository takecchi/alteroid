import type {
  ConversationBaselineResult,
  ConversationReadPosition,
  ConversationReadRead,
  ConversationReadStore,
} from '@alteroid/core';
import { eq, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { conversationRead, conversationReadBaseline } from './schema.js';

/** 高々1行しか持たない表なので、鍵は固定でよい（`env_profile` と同じ作法）。 */
const BASELINE_ID = 'default';

/**
 * 会話の既読の位置と基準時刻（クラウド段）。fs 版（`jobs/conversation-reads.json`）と
 * 同じものの器違いである。
 *
 * **「戻らない」は1文の upsert の中で決める**（`greatest`）。読んでから書く形にすると、
 * その間に別の入口が進めた位置を古い値で踏み戻しうる。基準時刻も `on conflict do nothing`
 * の1文で「一度決まったら変えない」を決める。
 */
export class PgConversationReadStore implements ConversationReadStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async read(): Promise<ConversationReadRead> {
    const baselineRows = await this.#db
      .select({ at: conversationReadBaseline.at })
      .from(conversationReadBaseline)
      .where(eq(conversationReadBaseline.id, BASELINE_ID))
      .limit(1);
    const rows = await this.#db
      .select({
        conversationId: conversationRead.conversationId,
        readThrough: conversationRead.readThrough,
        updatedAt: conversationRead.updatedAt,
      })
      .from(conversationRead);
    const positions: Record<string, ConversationReadPosition> = {};
    for (const row of rows) {
      positions[row.conversationId] = {
        readThrough: row.readThrough.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }
    return { state: 'ok', baseline: baselineRows[0]?.at.toISOString() ?? null, positions };
  }

  async ensureBaseline(at: string): Promise<ConversationBaselineResult> {
    await this.#db
      .insert(conversationReadBaseline)
      .values({ id: BASELINE_ID, at: new Date(at) })
      .onConflictDoNothing();
    const rows = await this.#db
      .select({ at: conversationReadBaseline.at })
      .from(conversationReadBaseline)
      .where(eq(conversationReadBaseline.id, BASELINE_ID))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new Error('conversation_read_baseline に行が無い');
    return { state: 'ok', baseline: row.at.toISOString() };
  }

  async advance(conversationId: string, readThrough: string): Promise<ConversationReadPosition> {
    const rows = await this.#db
      .insert(conversationRead)
      .values({
        conversationId,
        readThrough: new Date(readThrough),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: conversationRead.conversationId,
        set: {
          readThrough: sql`greatest(${conversationRead.readThrough}, excluded.read_through)`,
          // 位置が動いたときだけ時刻を進める（動かなかった呼びを「最後に既読にした
          // 時刻」として残さない）。
          updatedAt: sql`case when excluded.read_through > ${conversationRead.readThrough} then excluded.updated_at else ${conversationRead.updatedAt} end`,
        },
      })
      .returning({
        readThrough: conversationRead.readThrough,
        updatedAt: conversationRead.updatedAt,
      });
    const row = rows[0];
    if (row === undefined) throw new Error('conversation_read への書き込みが行を返さなかった');
    return { readThrough: row.readThrough.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }
}

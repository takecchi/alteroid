import type { CodexChatgptAuthRecord, CodexChatgptAuthStore } from '@alteroid/core';
import { and, eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { codexChatgptAuth } from './schema.js';

const ROW_ID = 'current';

type Row = typeof codexChatgptAuth.$inferSelect;

function recordOf(row: Row): CodexChatgptAuthRecord {
  return {
    value: row.value,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
    email: row.email,
    planType: row.planType,
    failure:
      row.failureAt === null
        ? null
        : { at: row.failureAt.toISOString(), reason: row.failureReason ?? '' },
  };
}

function columnsOf(record: CodexChatgptAuthRecord): Omit<Row, 'id'> {
  return {
    value: record.value,
    revision: record.revision,
    updatedAt: new Date(record.updatedAt),
    email: record.email,
    planType: record.planType,
    failureAt: record.failure === null ? null : new Date(record.failure.at),
    failureReason: record.failure === null ? null : record.failure.reason,
  };
}

/**
 * Codex の ChatGPT ログインの正本（#3939）。**書き戻しは1文の条件付き `update`**
 * （`where revision = <読んだ版>`）で決める——読んでから書く形に割ると、5台の runner の
 * 書き戻しが並んだときに古い値で新しい値を潰す。
 */
export class PgCodexChatgptAuthStore implements CodexChatgptAuthStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async get(): Promise<CodexChatgptAuthRecord | null> {
    const rows = await this.#db
      .select()
      .from(codexChatgptAuth)
      .where(eq(codexChatgptAuth.id, ROW_ID))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : recordOf(row);
  }

  async replace(record: CodexChatgptAuthRecord): Promise<void> {
    const columns = columnsOf(record);
    await this.#db
      .insert(codexChatgptAuth)
      .values({ id: ROW_ID, ...columns })
      .onConflictDoUpdate({ target: codexChatgptAuth.id, set: columns });
  }

  async compareAndSwap(expectedRevision: string, next: CodexChatgptAuthRecord): Promise<boolean> {
    const updated = await this.#db
      .update(codexChatgptAuth)
      .set(columnsOf(next))
      .where(and(eq(codexChatgptAuth.id, ROW_ID), eq(codexChatgptAuth.revision, expectedRevision)))
      .returning({ id: codexChatgptAuth.id });
    return updated.length > 0;
  }

  async remove(): Promise<boolean> {
    const removed = await this.#db
      .delete(codexChatgptAuth)
      .where(eq(codexChatgptAuth.id, ROW_ID))
      .returning({ id: codexChatgptAuth.id });
    return removed.length > 0;
  }
}

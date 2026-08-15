import { randomUUID } from 'node:crypto';

import { journalEntrySchema } from '@alteroid/core';
import type { JournalEntry, JournalEntryInput, JournalQuery, JournalStore } from '@alteroid/core';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
import { journal } from './schema.js';

/**
 * 日誌 = 追記専用のテーブル。
 *
 * 書き換えの口を用意しないのは fs 版と同じ理由である。「聞かずに実行した判断は
 * 必ず日誌に残る」ことが人間の事後否定＝最終承認の実体なので、後から消せる形に
 * しない（PRD「権限境界」）。
 */
export class PgJournalStore implements JournalStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async append(input: JournalEntryInput): Promise<JournalEntry> {
    const entry = journalEntrySchema.parse({
      ...input,
      id: randomUUID(),
      at: new Date().toISOString(),
    });

    // PostgreSQL は NUL を含む文字列を受け付けない。落とさずに投げると挿入ごと
    // 失敗し、呼び出し側（`#journal`）が握り潰すので**記録が静かに消える**。
    await this.#db.insert(journal).values({
      id: entry.id,
      at: new Date(entry.at),
      type: entry.type,
      entry: stripNulls(entry),
    });

    return entry;
  }

  /** 新しい順（＝追記の逆順）。同じ時刻に並んだ分も追記順が保たれる。 */
  async list(query: JournalQuery = {}): Promise<JournalEntry[]> {
    const filters = [
      ...(query.since === undefined ? [] : [gte(journal.at, new Date(query.since))]),
      ...(query.until === undefined ? [] : [lte(journal.at, new Date(query.until))]),
      ...(query.types === undefined || query.types.length === 0
        ? []
        : [inArray(journal.type, query.types)]),
    ];

    const rows = await this.#db
      .select({ entry: journal.entry })
      .from(journal)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(desc(journal.seq))
      .limit(query.limit ?? Number.MAX_SAFE_INTEGER);

    const found: JournalEntry[] = [];
    for (const row of rows) {
      // 壊れた行があっても日誌全体を読めなくしない（fs 版と同じ扱い）
      const parsed = journalEntrySchema.safeParse(row.entry);
      if (parsed.success) found.push(parsed.data);
    }
    return found;
  }

  /** id で1件引く（`id` は一意索引なので1行で当たる）。 */
  async get(id: string): Promise<JournalEntry | null> {
    const rows = await this.#db
      .select({ entry: journal.entry })
      .from(journal)
      .where(eq(journal.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = journalEntrySchema.safeParse(row.entry);
    return parsed.success ? parsed.data : null;
  }
}

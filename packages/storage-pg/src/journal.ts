import { randomUUID } from 'node:crypto';

import { journalEntrySchema, JournalAnchorNotFoundError } from '@alteroid/core';
import type { JournalEntry, JournalEntryInput, JournalQuery, JournalStore } from '@alteroid/core';
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toNumber } from './db.js';
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

  /**
   * `order` に応じた順（既定 `desc` ＝新しい順＝追記の逆順）。同じ時刻に
   * 並んだ分も `seq`（bigserial）が追記順を保つ。
   *
   * **`after`（issue #432 の2本目）は `where` 節の一部として、`types` /
   * `with` / `since` / `until` と同じ `and(...)` へ足す。** SQL の
   * `WHERE` は宣言した条件をまとめて1つの述語として評価してから
   * `ORDER BY` / `LIMIT` を掛けるので、この形にするだけで「錨の位置は
   * 絞り込みより前・`limit` より前で決まる」という契約が自然に満たされる
   * ——`limit` の後で錨を探す・絞り込んだ後の集合の中だけで錨を探す、
   * という壊れ方をする余地が構造的に無い。
   */
  async list(query: JournalQuery = {}): Promise<JournalEntry[]> {
    const order = query.order ?? 'desc';

    // **錨の `seq` は絞り込み（types/with/since/until）を一切通さずに引く。**
    // `id` と `at` の両方が一致する行が無ければ `JournalAnchorNotFoundError`
    // を投げる——`id` だけの一致では fs（`at` からファイルを決める）と答えが
    // 揃わない（`JournalQuery.after` の doc）。
    let afterSeq: number | undefined;
    if (query.after !== undefined) {
      const after = query.after;
      const rows = await this.#db
        .select({ seq: journal.seq })
        .from(journal)
        .where(and(eq(journal.id, after.id), eq(journal.at, new Date(after.at))))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new JournalAnchorNotFoundError(
          `after で指定された行（id=${after.id}, at=${after.at}）が見つからない`,
        );
      }
      afterSeq = toNumber(row.seq);
    }

    const filters = [
      ...(query.since === undefined ? [] : [gte(journal.at, new Date(query.since))]),
      ...(query.until === undefined ? [] : [lte(journal.at, new Date(query.until))]),
      // **`types: []`（空配列）も「絞らない」ではなく「どれにも当たらない」
      // へ倒す（issue #425）。すぐ下の `with` と同じ形——`length === 0` を
      // 特別扱いする条件を持っていたのは `types` だけだった。空配列が
      // そのまま `inArray` へ渡り、drizzle-orm の `inArray` が空配列に対して
      // `sql\`false\`` を返す（下の `with` のコメント参照）ので、0件という
      // 契約が構造的に満たされる。
      ...(query.types === undefined ? [] : [inArray(journal.type, query.types)]),
      // **`with` は `.limit()` より前（この `where` 節）で効かせる**
      // （issue #418 の穴の本体）。`entry` は jsonb なので `->>'with'` で
      // 引く — `exchange` を持たない種別ではこの式が `null` を返すので、
      // `inArray` の `IN (...)` には（NULL は何とも一致しない SQL の規則により）
      // 自動で当たらない。`types` を明示しなくても非 exchange が落ちる理由は
      // ここにある。
      //
      // `query.with` が `[]`（空配列）のとき、drizzle-orm の `inArray` は
      // `sql\`false\`` を返す（`drizzle-orm@0.45.2` の
      // `sql/expressions/conditions.js` の `inArray` 実装。空配列を
      // `in ()` という不正な SQL へ落とさないための特別扱い）ので、
      // 0件という契約がそのまま満たされる。
      ...(query.with === undefined ? [] : [inArray(sql`(${journal.entry}->>'with')`, query.with)]),
      // **`order` の向きに応じて `gt` / `lt` を切り替える。** `desc` は錨より
      // 古い側（`seq` が小さい側）、`asc` は錨より新しい側（`seq` が大きい側）。
      ...(afterSeq === undefined
        ? []
        : [order === 'desc' ? lt(journal.seq, afterSeq) : gt(journal.seq, afterSeq)]),
    ];

    const rows = await this.#db
      .select({ entry: journal.entry })
      .from(journal)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(order === 'desc' ? desc(journal.seq) : asc(journal.seq))
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

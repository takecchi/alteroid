import { randomUUID } from 'node:crypto';

import {
  journalEntrySchema,
  JournalAnchorNotFoundError,
  journalRowType,
  JOURNAL_SEARCH_FIELDS,
  hasNul,
  stripNulDeep,
  noteDroppedJournalRow,
  noteDroppedJournalRowsSummary,
  UnreadableJournalEntryError,
} from '@alteroid/core';
import type {
  JournalEntry,
  JournalEntryInput,
  JournalPage,
  JournalQuery,
  JournalStore,
} from '@alteroid/core';
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toNumber } from './db.js';
import { journal } from './schema.js';

// `entry` に `id` / `at` / `type` を書かない: 列から復元できる二重持ちで、日誌は行数が多く heap を食うため。
function withoutRowColumns(entry: JournalEntry): Omit<JournalEntry, 'id' | 'at' | 'type'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, at, type, ...rest } = entry;
  return rest;
}

const ROW_SELECTION = {
  id: journal.id,
  at: journal.at,
  type: journal.type,
  entry: journal.entry,
};

// `entry` が3つを持っていればそちらを優先する: 古い行は書いた時点の値をそのまま返すため。
function restoreEntry(row: { id: string; at: Date; type: string; entry: unknown }): unknown {
  const stored =
    typeof row.entry === 'object' && row.entry !== null && !Array.isArray(row.entry)
      ? (row.entry as Record<string, unknown>)
      : {};
  return { id: row.id, at: row.at.toISOString(), type: row.type, ...stored };
}

export class PgJournalStore implements JournalStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async append(input: JournalEntryInput): Promise<JournalEntry> {
    const entry = journalEntrySchema.parse({
      ...stripNulDeep(input),
      id: randomUUID(),
      at: new Date().toISOString(),
    });

    // NUL を落とす: 投げると挿入ごと失敗し、呼び出し側が握り潰して記録が静かに消えるため。
    await this.#db.insert(journal).values({
      id: entry.id,
      at: new Date(entry.at),
      type: entry.type,
      entry: stripNulls(withoutRowColumns(entry)),
    });

    return entry;
  }

  async list(query: JournalQuery = {}): Promise<JournalEntry[]> {
    return (await this.listPage(query)).entries;
  }

  async listPage(query: JournalQuery = {}): Promise<JournalPage> {
    const order = query.order ?? 'desc';

    // 錨の `seq` を絞り込みに通さない。`id` だけの一致にしない: fs（`at` からファイルを決める）と答えが揃わないため。
    let afterSeq: number | undefined;
    if (query.after !== undefined) {
      const after = query.after;
      // NUL を含む id を DB に投げない: text が NUL を受け付けずエラーになるため。
      if (hasNul(after.id)) {
        throw new JournalAnchorNotFoundError(
          `after で指定された行（id=${after.id}, at=${after.at}）が見つからない`,
        );
      }
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
      // 墓標のある会話の `exchange` を外す（#4218）。`.limit()` の前（`where` 節）で効かせる: 後で外すと窓が短くなり、`reachedStart` が誤るため。
      hiddenConversationExchangeExcluded(),
      // 空配列を「絞らない」へ倒さない: `inArray` が空配列に `false` を返すので、どれにも当たらない（0件）にする。
      ...(query.types === undefined ? [] : [inArray(journal.type, query.types)]),
      // `.limit()` の後で絞らない: `where` 節で効かせる。
      ...(query.with === undefined ? [] : [inArray(sql`(${journal.entry}->>'with')`, query.with)]),
      ...(query.q === undefined
        ? []
        : [hasNul(query.q) ? sql`false` : journalSearchMatches(query.q)]),
      ...(afterSeq === undefined
        ? []
        : [order === 'desc' ? lt(journal.seq, afterSeq) : gt(journal.seq, afterSeq)]),
    ];

    const rows = await this.#db
      .select(ROW_SELECTION)
      .from(journal)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(order === 'desc' ? desc(journal.seq) : asc(journal.seq))
      .limit(
        query.limit === undefined
          ? Number.MAX_SAFE_INTEGER
          : query.limit > 0
            ? query.limit + 1
            : query.limit,
      );

    const pageLimit = query.limit !== undefined && query.limit > 0 ? query.limit : undefined;
    const hasMore = pageLimit !== undefined && rows.length > pageLimit;
    const pageRows = pageLimit === undefined ? rows : rows.slice(0, pageLimit);
    const lastRow = pageRows[pageRows.length - 1];

    const found: JournalEntry[] = [];
    // インスタンスに状態を持たせない: 呼び出し1回ぶんのローカルな器で足りるため。
    const dropped = new Map<string, number>();
    for (const row of pageRows) {
      const restored = restoreEntry(row);
      const parsed = journalEntrySchema.safeParse(restored);
      if (parsed.success) {
        found.push(parsed.data);
      } else {
        noteDroppedJournalRow(
          dropped,
          'unknown-shape',
          journalRowType(restored),
          byteLength(row.entry),
        );
      }
    }
    noteDroppedJournalRowsSummary(dropped);
    return {
      entries: found,
      next:
        hasMore && lastRow !== undefined ? { id: lastRow.id, at: lastRow.at.toISOString() } : null,
    };
  }

  async get(id: string): Promise<JournalEntry | null> {
    if (hasNul(id)) return null;
    const rows = await this.#db
      .select(ROW_SELECTION)
      .from(journal)
      .where(and(eq(journal.id, id), hiddenConversationExchangeExcluded()))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const restored = restoreEntry(row);
    const parsed = journalEntrySchema.safeParse(restored);
    if (parsed.success) return parsed.data;
    const dropped = new Map<string, number>();
    noteDroppedJournalRow(
      dropped,
      'unknown-shape',
      journalRowType(restored),
      byteLength(row.entry),
    );
    noteDroppedJournalRowsSummary(dropped);
    // `null` を返さない: 行は在るため。
    throw new UnreadableJournalEntryError({ id });
  }

  async oldestAt(): Promise<string | null> {
    // 外した行（消した会話の exchange・墓標が名指しした行）の時刻を返さない: list / get と同じ絞りを通す
    const rows = await this.#db
      .select({ at: journal.at })
      .from(journal)
      .where(hiddenConversationExchangeExcluded())
      .orderBy(asc(journal.at))
      .limit(1);
    return rows[0]?.at.toISOString() ?? null;
  }

  async clear(): Promise<number> {
    const removed = await this.#db.delete(journal).returning({ seq: journal.seq });
    return removed.length;
  }
}

// 墓標（`conversation_deleted`）のある会話の `exchange` を外す条件（#4218）。部分式索引 `journal_conversation_deleted_idx` で引く。
// 外側の表の列は `sql.raw` で修飾して書く: drizzle は単表の select の列を修飾しない場合があり、内側（別名 `t`）の列と取り違えるため。
// 墓標が名指しした行（`hiddenEntryIds`）は、墓標の種別で絞った行だけから引く: 墓標は会話の数に比べて少ないため
function hiddenConversationExchangeExcluded(): SQL {
  return sql`NOT (${sql.raw('"journal"."type"')} = 'exchange' AND EXISTS (SELECT 1 FROM journal t WHERE t.type = 'conversation_deleted' AND t.entry->>'deletedConversationId' = ${sql.raw('"journal"."entry"')}->>'conversationId')) AND NOT EXISTS (SELECT 1 FROM journal h WHERE h.type = 'conversation_deleted' AND h.entry->'hiddenEntryIds' ? ${sql.raw('"journal"."id"')})`;
}

// `JSON.stringify` へ戻して数える: pg の駆動子は渡す時点で JSON を解いてしまい、生の行文字列の長さが取れないため。
function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

// 全文検索（`tsvector`）にしない: 部分一致にならず、日本語を語に割れず、fs / インメモリと答えが揃わないため。
// 索引を張らない: `pg_trgm` は拡張で権限の要求が強くなり、実データでの遅さを測っていないため。
function journalSearchMatches(q: string): SQL {
  // 空の語を欄ごとの `OR` に任せない: 欄を持たない種別だけが落ちるため。
  if (q === '') return sql`true`;
  const pattern = likePattern(q);
  return sql`(${journalSearchFieldMatchesSql(pattern)})`;
}

// 欄名をバインド変数にしない: `jsonb ->> unknown` が `->>(jsonb,int)` と `->>(jsonb,text)` のどちらか決まらず落ちるため、`sql.raw` で埋める。
// 欄名を書き写さない: JS 側と同じ `JOURNAL_SEARCH_FIELDS` から作らないと、片方だけ直して見る欄がずれるため。
function journalSearchFieldMatchesSql(pattern: string): SQL {
  return sql.join(
    JOURNAL_SEARCH_FIELDS.map(
      (field) =>
        sql`coalesce(${journal.entry}->>${sql.raw(`'${assertPlainFieldName(field)}'`)}, '') ilike ${pattern} escape ${sql.raw("'\\'")}`,
    ),
    sql` or `,
  );
}

// 検算を外さない: `sql.raw` は呼び出し側が安全な値だけを渡す性質に頼っており、定数の出所が変わってもそれが消えたことが見えないため。
function assertPlainFieldName(field: string): string {
  if (!/^[A-Za-z]+$/.test(field)) {
    throw new Error(`日誌の検索対象の欄名が英字だけではない: ${JSON.stringify(field)}`);
  }
  return field;
}

// `%` と `_` をワイルドカードとして通さない: pg だけが `q: '50%'` で全件を返すため。`\` を先に倍にする: 順序が逆だと足した `\` をまた倍にするため。
function likePattern(q: string): string {
  return `%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

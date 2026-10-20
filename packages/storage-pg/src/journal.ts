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

/** 返答の覚えを読み足すとき、前回の最後の `seq` から手前に重ねて読む行数（#5089。`humanReplies` の注記） */
export const HUMAN_REPLIES_OVERLAP = 1_000;
/** 返答の覚えを全部読み直す間隔（ms） */
export const HUMAN_REPLIES_FULL_REFRESH_MS = 10 * 60_000;

function maxKey(map: ReadonlyMap<number, unknown>): number {
  let max = 0;
  for (const key of map.keys()) if (key > max) max = key;
  return max;
}

export class PgJournalStore implements JournalStore {
  readonly #db: Db;
  readonly #now: () => number;
  #humanReplies: {
    tombstones: string;
    fullAt: number;
    throughSeq: number;
    replies: Map<number, { conversationId: string; at: string }>;
  } | null = null;

  constructor(db: Db, options: { now?: () => number } = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
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
      // 墓標のある会話の `exchange` を外す。`.limit()` の前（`where` 節）で効かせる: 後で外すと窓が短くなり、`reachedStart` が誤るため。
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

  // 本文（`text` 等）を流さず、会話 id と時刻だけを読む（#5089）。絞りは `list({ types: ['exchange'], with: ['human'] })` と同じ式で、`journal_exchange_with_seq_idx` に乗る。
  // `list` は読み出しで型（`journalEntrySchema`）に合わない行を落とすので、ここでも返答の判定に使う欄と必須の本文の型までは SQL で確かめる。
  // それ以外の欄だけが型に合わない行（書き込み時の検査があるので、ふつうは無い）は、`list` と違って数える
  //
  // 覚えて足していく（#5089）: 日誌は追記専用（消すのは `clear()` だけで、行を書き換えない）なので、返答の一覧は前回より後ろの行だけ読み足せば済む。
  // 前回から外す行が変わりうるのは墓標（`conversation_deleted`）が増減したときだけなので、墓標の件数と最後の `seq` が変わったら全部読み直す。
  // `seq` は払い出しの順で、確定の順とはずれうる（先に払い出した行が後で確定する）ので、読み足すときは手前の `HUMAN_REPLIES_OVERLAP` 行ぶん重ねて読み、`seq` で重複を除く。
  // 念のため `HUMAN_REPLIES_FULL_REFRESH_MS` ごとに全部読み直す
  async humanReplies(): Promise<{ conversationId: string; at: string }[]> {
    const tombstones = (
      await this.#db
        .select({
          signature: sql<string>`count(*)::text || ':' || coalesce(max(${journal.seq}), 0)::text`,
        })
        .from(journal)
        .where(eq(journal.type, 'conversation_deleted'))
    )[0]?.signature;
    const cache = this.#humanReplies;
    const fresh =
      cache !== null &&
      cache.tombstones === tombstones &&
      this.#now() - cache.fullAt < HUMAN_REPLIES_FULL_REFRESH_MS;
    if (!fresh) {
      const replies = new Map<number, { conversationId: string; at: string }>();
      for (const row of await this.#readHumanReplies(undefined)) {
        replies.set(row.seq, { conversationId: row.conversationId, at: row.at });
      }
      this.#humanReplies = {
        tombstones: tombstones ?? '',
        fullAt: this.#now(),
        throughSeq: maxKey(replies),
        replies,
      };
    } else {
      for (const row of await this.#readHumanReplies(cache.throughSeq - HUMAN_REPLIES_OVERLAP)) {
        cache.replies.set(row.seq, { conversationId: row.conversationId, at: row.at });
        if (row.seq > cache.throughSeq) cache.throughSeq = row.seq;
      }
    }
    return [...(this.#humanReplies?.replies.values() ?? [])].map((reply) => ({ ...reply }));
  }

  async #readHumanReplies(
    afterSeq: number | undefined,
  ): Promise<{ seq: number; conversationId: string; at: string }[]> {
    const rows = await this.#db
      .select({
        seq: journal.seq,
        at: journal.at,
        conversationId: sql<string>`${journal.entry}->>'conversationId'`,
      })
      .from(journal)
      .where(
        and(
          hiddenConversationExchangeExcluded(),
          eq(journal.type, 'exchange'),
          sql`(${journal.entry}->>'with') = 'human'`,
          sql`${journal.entry}->>'role' = 'outbound'`,
          sql`jsonb_typeof(${journal.entry}->'conversationId') = 'string'`,
          sql`jsonb_typeof(${journal.entry}->'text') = 'string'`,
          ...(afterSeq === undefined ? [] : [gt(journal.seq, afterSeq)]),
        ),
      );
    return rows.map((row) => ({
      seq: toNumber(row.seq),
      conversationId: row.conversationId,
      at: row.at.toISOString(),
    }));
  }

  async clear(): Promise<number> {
    const removed = await this.#db.delete(journal).returning({ seq: journal.seq });
    // 消したら返答の覚えも捨てる（読み足しは前回より後ろしか見ないため）
    this.#humanReplies = null;
    return removed.length;
  }
}

// 墓標（`conversation_deleted`）のある会話の `exchange` を外す条件。部分式索引 `journal_conversation_deleted_idx` で引く。
// 外側の表の列は `sql.raw` で修飾して書く: drizzle は単表の select の列を修飾しない場合があり、内側（別名 `t`）の列と取り違えるため。
// 墓標が名指しした行（`hiddenEntryIds`）は、墓標の種別で絞った行だけから引く: 墓標は会話の数に比べて少ないため
// 名指しした id は、墓標から id の集合に開いて、外側の `id` が集合に無いかで見る（#5089）: `h.entry->'hiddenEntryIds' ? journal.id` と書くと、
// 外側の行ごとに全墓標の jsonb を評価する入れ子の反結合になる（偽のデータの 8,000 行 × 墓標 50 で約 300ms）。
// `NOT EXISTS (… named.hid = journal.id)` にもしない: 外側の行数の見積もりが小さいと、墓標の展開を外側の行ごとにやり直す入れ子の反結合が選ばれ、元より遅くなる（同じデータで 7 秒）。
// `NOT IN (相関の無い部分問い合わせ)` なら、集合をハッシュにして1回だけ作る（hashed SubPlan）ので、外側の計画に左右されない。
// `NOT IN` は集合に NULL が混ざると全行を外すので、NULL を返さない形で開き、念のため `IS NOT NULL` でも絞る。
// 開き方は jsonb の `?` と同じ意味にする: 配列なら文字列の要素、オブジェクトなら鍵、文字列ならその値（数・真偽・null の要素は名指しに数えない）
function hiddenConversationExchangeExcluded(): SQL {
  return sql`NOT (${sql.raw('"journal"."type"')} = 'exchange' AND EXISTS (SELECT 1 FROM journal t WHERE t.type = 'conversation_deleted' AND t.entry->>'deletedConversationId' = ${sql.raw('"journal"."entry"')}->>'conversationId')) AND ${sql.raw('"journal"."id"')} NOT IN (${HIDDEN_ENTRY_IDS})`;
}

const HIDDEN_ENTRY_IDS = sql.raw(
  `SELECT named.hid FROM journal h CROSS JOIN LATERAL (` +
    `SELECT e #>> '{}' AS hid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(h.entry->'hiddenEntryIds') = 'array' THEN h.entry->'hiddenEntryIds' ELSE '[]'::jsonb END) e WHERE jsonb_typeof(e) = 'string' ` +
    `UNION ALL SELECT k FROM jsonb_object_keys(CASE WHEN jsonb_typeof(h.entry->'hiddenEntryIds') = 'object' THEN h.entry->'hiddenEntryIds' ELSE '{}'::jsonb END) k ` +
    `UNION ALL SELECT h.entry->>'hiddenEntryIds' WHERE jsonb_typeof(h.entry->'hiddenEntryIds') = 'string'` +
    `) named WHERE h.type = 'conversation_deleted' AND named.hid IS NOT NULL`,
);

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

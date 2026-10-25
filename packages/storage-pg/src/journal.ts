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
  notePhase,
  UnreadableJournalEntryError,
} from '@alteroid/core';
import type {
  ConversationWindowRow,
  ExchangeTextHead,
  JournalCursor,
  JournalEntry,
  JournalEntryInput,
  JournalPage,
  JournalQuery,
  JournalStore,
} from '@alteroid/core';
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso, toNumber } from './db.js';
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

// `execute` の結果は器（node-postgres・PGlite）で形が違う: 配列そのものか、`rows` を持つ形
function rowsOf(result: unknown): unknown[] {
  return Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
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

/**
 * 印に添える本文の長さの見当（文字数）。行の1段目と、`tool_use` の `input` の1段目の文字列だけを足す。
 * 深くは潜らない: 印のための走査で重くしないため。入れ子の大きな値は数えない（見当であって大きさの正本ではない）
 */
function journalTextLengthOf(input: JournalEntryInput): number {
  let total = 0;
  const add = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    for (const field of Object.values(value as Record<string, unknown>)) {
      if (typeof field === 'string') total += field.length;
    }
  };
  add(input);
  if (input.type === 'tool_use') add(input.input);
  return total;
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
  #hidden: { signature: string; sets: HiddenSets } | null = null;

  constructor(db: Db, options: { now?: () => number } = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  async append(input: JournalEntryInput): Promise<JournalEntry> {
    // 書く前の同期の処理（NUL 落とし・検査・JSON への整形）は行の大きさに比例するので、前後に印を打つ（#4485）。
    // 大きさは数え直さない（数え直しそのものが重い）: 呼び手がもう持っている本文の欄の長さだけを添える
    notePhase(`journal-append:${input.type}:${String(journalTextLengthOf(input))}ch`);
    const entry = journalEntrySchema.parse({
      ...stripNulDeep(input),
      id: randomUUID(),
      at: new Date().toISOString(),
    });

    // NUL を落とす: 投げると挿入ごと失敗し、呼び出し側が握り潰して記録が静かに消えるため。
    const insert = this.#db.insert(journal).values({
      id: entry.id,
      at: new Date(entry.at),
      type: entry.type,
      entry: stripNulls(withoutRowColumns(entry)),
    });
    notePhase('journal-append-built');
    await insert;

    return entry;
  }

  async list(query: JournalQuery = {}): Promise<JournalEntry[]> {
    return (await this.listPage(query)).entries;
  }

  async listPage(query: JournalQuery = {}): Promise<JournalPage> {
    const order = query.order ?? 'desc';

    const afterSeq = query.after === undefined ? undefined : await this.#anchorSeq(query.after);

    const hidden = await this.#hiddenSets(this.#db);
    const filters = [
      ...(query.since === undefined ? [] : [gte(journal.at, new Date(query.since))]),
      ...(query.until === undefined ? [] : [lte(journal.at, new Date(query.until))]),
      // 墓標のある会話の `exchange` を外す。`.limit()` の前（`where` 節）で効かせる: 後で外すと窓が短くなり、`reachedStart` が誤るため。
      hiddenConversationExchangeExcluded(hidden),
      // 空配列を「絞らない」へ倒さない: `inArray` が空配列に `false` を返すので、どれにも当たらない（0件）にする。
      ...(query.types === undefined ? [] : [inArray(journal.type, query.types)]),
      // `.limit()` の後で絞らない: `where` 節で効かせる。
      ...(query.with === undefined ? [] : [inArray(sql`(${journal.entry}->>'with')`, query.with)]),
      // NUL を含む値は DB に投げない（`q` と同じ）: text が NUL を受け付けずエラーになるため、どれにも当たらない扱いにする。
      ...(query.conversationId === undefined
        ? []
        : [
            hasNul(query.conversationId)
              ? sql`false`
              : sql`(${journal.entry}->>'conversationId') = ${query.conversationId}`,
          ]),
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

  // 錨の `seq` を絞り込みに通さない。`id` だけの一致にしない: fs（`at` からファイルを決める）と答えが揃わないため。
  // `listPage` と `conversationIdsAfter` が同じ引き方を共有する: 錨の見つけ方がずれると、2つの口の答えが揃わなくなるため。
  async #anchorSeq(after: { id: string; at: string }): Promise<number> {
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
    return toNumber(row.seq);
  }

  async get(id: string): Promise<JournalEntry | null> {
    if (hasNul(id)) return null;
    const rows = await this.#db
      .select(ROW_SELECTION)
      .from(journal)
      .where(
        and(
          eq(journal.id, id),
          hiddenConversationExchangeExcluded(await this.#hiddenSets(this.#db)),
        ),
      )
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
      .where(hiddenConversationExchangeExcluded(await this.#hiddenSets(this.#db)))
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
    const tombstones = await this.#tombstoneSignature(this.#db);
    // 印は1本だけ引いて、覚えの読み直しの判定（`#hiddenSets`）と共有する
    const hidden = await this.#hiddenSets(this.#db, tombstones);
    const cache = this.#humanReplies;
    const fresh =
      cache !== null &&
      cache.tombstones === tombstones &&
      this.#now() - cache.fullAt < HUMAN_REPLIES_FULL_REFRESH_MS;
    if (!fresh) {
      const replies = new Map<number, { conversationId: string; at: string }>();
      for (const row of await this.#readHumanReplies(undefined, hidden)) {
        replies.set(row.seq, { conversationId: row.conversationId, at: row.at });
      }
      this.#humanReplies = {
        tombstones: tombstones ?? '',
        fullAt: this.#now(),
        throughSeq: maxKey(replies),
        replies,
      };
    } else {
      for (const row of await this.#readHumanReplies(
        cache.throughSeq - HUMAN_REPLIES_OVERLAP,
        hidden,
      )) {
        cache.replies.set(row.seq, { conversationId: row.conversationId, at: row.at });
        if (row.seq > cache.throughSeq) cache.throughSeq = row.seq;
      }
    }
    return [...(this.#humanReplies?.replies.values() ?? [])].map((reply) => ({ ...reply }));
  }

  async #readHumanReplies(
    afterSeq: number | undefined,
    hidden: HiddenSets,
  ): Promise<{ seq: number; conversationId: string; at: string }[]> {
    // 欄ごとに `entry->'…'` を書かず、`jsonb_to_record` で1行1回だけ開く（#5264）: 欄ごとに書くと、TOAST に出た返答の本文を欄の数（消した会話の判定を含めて 5〜7 回）だけ展開し直し、
    // 偽の日誌（返答 9,491 行）で全部読み1回に触るページが 62,242 から 26,437 に、時間が 168ms から 45ms に減った（冷えた読みのディスクの read は 14,058 ページで変わらない）。
    // `with`・`role` だけは `entry->>'…'` のまま書く: 部分索引 `journal_human_replies_idx` の述語と同じ式でないと、planner が索引を選ばないため。
    // 消した会話の判定は `hiddenConversationExchangeExcluded` と同じ意味を、開いた値で書く（ここに来る行は `exchange` で会話 id が文字列なので、
    // 「`exchange` でない／会話 id が無い」の枝は常に偽になり、残るのは会話 id と行 id の2つの照合だけ）
    const result = await this.#db.execute(sql`
      select ${journal.seq} as seq, ${journal.at} as at, r."conversationId" #>> '{}' as "conversationId"
      from ${journal}
      cross join lateral jsonb_to_record(${journal.entry}) as r(text jsonb, "conversationId" jsonb)
      where ${journal.type} = 'exchange'
        and (${journal.entry}->>'with') = 'human'
        and (${journal.entry}->>'role') = 'outbound'
        and jsonb_typeof(r."conversationId") = 'string'
        and jsonb_typeof(r.text) = 'string'
        and (r."conversationId" #>> '{}') <> all(${sql.param(hidden.deletedConversationIds)}::text[])
        and ${journal.id} <> all(${sql.param(hidden.hiddenEntryIds)}::text[])
        ${afterSeq === undefined ? sql`` : sql`and ${journal.seq} > ${afterSeq}`}
    `);
    return (
      rowsOf(result) as { seq: number | string; at: Date | string; conversationId: string }[]
    ).map((row) => ({
      seq: toNumber(row.seq),
      conversationId: row.conversationId,
      at: toIso(row.at),
    }));
  }

  // 本文を流さず、印の id だけを読む（#5089）。部分索引 `journal_withdrawals_idx` に乗るよう、索引の述語と同じ式で絞る（`migrate.ts`）。
  // `list` は型（`journalEntrySchema`）に合わない行を落とすので、ここでも印の欄の型までは SQL で確かめる（`humanReplies` と同じ線）
  async withdrawnClientMessageIds(query: {
    since: string;
    conversationId?: string;
  }): Promise<string[]> {
    if (query.conversationId !== undefined && hasNul(query.conversationId)) return [];
    // この問い合わせだけ JIT を切る: 印は数十行しか無いのに、部分索引の述語（jsonb の欄）に統計が無く行数を大きく見積もるため、
    // 費用が JIT の閾値を越え、実行 0.1ms 未満の問い合わせに毎回 100ms を超える翻訳を払っていた（偽の日誌 27 万行で実測）。
    // 統計（CREATE STATISTICS）で見積もりを直さない: 印は日誌のごく一部で、ANALYZE の標本に入るかどうかで見積もりが揺れるため。
    // DB 全体の `jit` には触れない（`set_config(..., true)` はこのトランザクションの中だけ効く。`withStatementTimeout` と同じ作法）
    const rows = await this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('jit', 'off', true)`);
      const hidden = await this.#hiddenSets(tx);
      return tx
        .select({ id: sql<string>`${journal.entry}->>'withdrawnClientMessageId'` })
        .from(journal)
        .where(
          and(
            hiddenConversationExchangeExcluded(hidden),
            eq(journal.type, 'exchange'),
            sql`(${journal.entry}->>'with') = 'self'`,
            sql`(${journal.entry}->>'withdrawnClientMessageId') is not null`,
            sql`jsonb_typeof(${journal.entry}->'withdrawnClientMessageId') = 'string'`,
            gte(journal.at, new Date(query.since)),
            ...(query.conversationId === undefined
              ? []
              : [sql`(${journal.entry}->>'conversationId') = ${query.conversationId}`]),
          ),
        );
    });
    return rows.map((row) => row.id);
  }

  // 本文（道具の入力）を流さず、層（`actor`）ごとの件数だけ読む。`journal_type_at_idx`（type, at）に乗る。
  // `list` は型（`journalEntrySchema`）に合わない行を落とすので、ここでも必須の文字列の欄（`actor`・`tool`）の型までは SQL で確かめる（`humanReplies` と同じ線）。
  // それ以外の欄だけが型に合わない行（書き込み時の検査があるので、ふつうは無い）は、`list` と違って数える
  async countToolUsesByActor(query: {
    since: string;
    until: string;
  }): Promise<{ actor: string; count: number }[]> {
    const actor = sql<string>`${journal.entry}->>'actor'`;
    // この問い合わせだけ JIT を切る（`withdrawnClientMessageIds` と同じ作法）: 窓の行を数えるだけなのに費用が JIT の閾値を越え、偽の日誌 60 万行で実行の大半（約 110ms）が翻訳だったため
    const rows = await this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('jit', 'off', true)`);
      const hidden = await this.#hiddenSets(tx);
      return tx
        .select({ actor, count: sql<number>`count(*)::int` })
        .from(journal)
        .where(
          and(
            hiddenConversationExchangeExcluded(hidden),
            eq(journal.type, 'tool_use'),
            gte(journal.at, new Date(query.since)),
            lte(journal.at, new Date(query.until)),
            sql`jsonb_typeof(${journal.entry}->'actor') = 'string'`,
            sql`jsonb_typeof(${journal.entry}->'tool') = 'string'`,
          ),
        )
        .groupBy(actor);
    });
    return rows.map((row) => ({ actor: row.actor, count: toNumber(row.count) }));
  }

  // 本文を流さず、前方一致する会話 id だけを、その会話の最新の発言（`seq` の最大）の新しい順に返す。
  // 絞りは `listPage({ types: ['exchange'], with: ['human'] })` と同じ式で、`journal_human_exchange_seq_idx` に乗る。
  // 型の確かめは `conversationIdsAfter` と同じ線（判定に使う欄と必須の欄まで）。`jsonb_to_record` で1行1回だけ開く: 欄ごとに `entry->'…'` を書くと、TOAST に出た本文を欄の数だけ展開し直すため
  async conversationIdsWithPrefix(query: { prefix: string; limit: number }): Promise<string[]> {
    // NUL を含む値は DB に投げない（`q` と同じ）: text が NUL を受け付けずエラーになるため。どの会話 id も NUL を含まないので、当たりは無い
    if (hasNul(query.prefix) || query.limit <= 0) return [];
    const entry = journal.entry;
    // この問い合わせだけ JIT を切る（`withdrawnClientMessageIds` と同じ作法）: 人間との往復を数千行開いて束ねるだけなのに、費用が JIT の閾値を越えうるため
    const result = await this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('jit', 'off', true)`);
      const hidden = await this.#hiddenSets(tx);
      return tx.execute(sql`
        select r."conversationId" #>> '{}' as id, max(${journal.seq}) as last
        from ${journal}
        cross join lateral jsonb_to_record(${entry}) as r(role text, text jsonb, "conversationId" jsonb)
        where ${and(
          hiddenConversationExchangeExcluded(hidden),
          inArray(journal.type, ['exchange']),
          inArray(sql`(${entry}->>'with')`, ['human']),
        )}
          and r.role in ('inbound', 'outbound')
          and jsonb_typeof(r.text) = 'string'
          and jsonb_typeof(r."conversationId") = 'string'
          and starts_with(r."conversationId" #>> '{}', ${query.prefix})
        group by 1
        order by last desc
        limit ${query.limit}
      `);
    });
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    return (rows as { id: string }[]).map((row) => row.id);
  }

  // 本文を流さず、会話 id だけを読む。絞りは `listPage({ types: ['exchange'], with: ['human'], order: 'asc', after, until })` と同じ式で、`journal_exchange_with_seq_idx`（`entry->>'with'`, `seq`）に乗る。
  // `list` は型（`journalEntrySchema`）に合わない行を落とすので、ここでも判定に使う欄（`with`）と必須の欄（`role`・`text`）と `conversationId` の型までは SQL で確かめる（`humanReplies` と同じ線）。
  // それ以外の欄だけが型に合わない行（書き込み時の検査があるので、ふつうは無い）は、`list` と違って数える
  async conversationIdsAfter(query: { after: JournalCursor; until?: string }): Promise<string[]> {
    const afterSeq = await this.#anchorSeq(query.after);
    const conversationId = sql<string>`${journal.entry}->>'conversationId'`;
    // この問い合わせだけ JIT を切る（`withdrawnClientMessageIds` と同じ作法）: 索引で数千行を拾うだけなのに費用が JIT の閾値を越え、偽の日誌 60 万行で実行 121ms のうち約 107ms が翻訳だったため
    const rows = await this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('jit', 'off', true)`);
      const hidden = await this.#hiddenSets(tx);
      return tx
        .selectDistinct({ conversationId })
        .from(journal)
        .where(
          and(
            hiddenConversationExchangeExcluded(hidden),
            eq(journal.type, 'exchange'),
            sql`(${journal.entry}->>'with') = 'human'`,
            gt(journal.seq, afterSeq),
            ...(query.until === undefined ? [] : [lte(journal.at, new Date(query.until))]),
            sql`${journal.entry}->>'role' in ('inbound', 'outbound')`,
            sql`jsonb_typeof(${journal.entry}->'text') = 'string'`,
            sql`jsonb_typeof(${journal.entry}->'conversationId') = 'string'`,
          ),
        );
    });
    return rows.map((row) => row.conversationId);
  }

  // 本文を流さず、会話の一覧の判定に要る欄だけを読む。絞り・並び・`limit`・継続点は `listPage({ types: ['exchange'], with: ['human'], order: 'desc', limit: scan, ... })` と同じにする
  // （`journal_human_exchange_seq_idx` に乗る）。型の確かめは `listPage` と同じく `limit` の後で行う: 前で絞ると、読めない行の分だけ窓が古い側へ伸び、`listPage` と窓がずれるため。
  // 確かめるのは判定に使う欄と必須の欄（`role`・`text`）までで、それ以外の欄だけが型に合わない行は返す（`conversationIdsAfter` と同じ線）
  async conversationWindowHeads(query: {
    scan: number;
    since?: string;
    until?: string;
    after?: JournalCursor;
  }): Promise<{ rows: ConversationWindowRow[]; next: JournalCursor | null }> {
    const afterSeq = query.after === undefined ? undefined : await this.#anchorSeq(query.after);
    const hidden = await this.#hiddenSets(this.#db);
    const entry = journal.entry;
    // 絞りは `listPage` と同じ式・同じ順に組む: 部分索引の述語との一致を planner が確かめられる形を崩さないため
    const filters = and(
      ...(query.since === undefined ? [] : [gte(journal.at, new Date(query.since))]),
      ...(query.until === undefined ? [] : [lte(journal.at, new Date(query.until))]),
      hiddenConversationExchangeExcluded(hidden),
      inArray(journal.type, ['exchange']),
      inArray(sql`(${entry}->>'with')`, ['human']),
      ...(afterSeq === undefined ? [] : [lt(journal.seq, afterSeq)]),
    );
    const limit = query.scan > 0 ? query.scan + 1 : query.scan;
    // 欄ごとに `entry->'…'` を書かず、`jsonb_to_record` で1行1回だけ開く: 欄ごとに書くと、TOAST に出た本文を欄の数だけ展開し直し、
    // 偽の日誌で窓1回に触るページが 8,198 から 32,443 に増えた（1行1回なら 11,440。本文ごと運ぶ形の 8,198 との差は、絞りが先に1回開く分）
    const result = await this.#db.execute(sql`
      select ${journal.id} as id, ${journal.at} as at, r.role as role,
        jsonb_typeof(r.text) = 'string' as "textIsString",
        case when jsonb_typeof(r."conversationId") = 'string' then r."conversationId" #>> '{}' end as "conversationId",
        case when jsonb_typeof(r.supersedes) = 'string' then r.supersedes #>> '{}' end as supersedes,
        case when jsonb_typeof(r."clientMessageId") = 'string' then r."clientMessageId" #>> '{}' end as "clientMessageId",
        r."turnFailure" as "turnFailure"
      from ${journal}
      cross join lateral jsonb_to_record(${entry}) as r(role text, text jsonb, "conversationId" jsonb, supersedes jsonb, "clientMessageId" jsonb, "turnFailure" text)
      where ${filters}
      order by ${journal.seq} desc
      limit ${limit}
    `);
    const rows = rowsOf(result) as {
      id: string;
      at: Date | string;
      role: string | null;
      textIsString: boolean | null;
      conversationId: string | null;
      supersedes: string | null;
      clientMessageId: string | null;
      turnFailure: string | null;
    }[];

    const pageLimit = query.scan > 0 ? query.scan : undefined;
    const hasMore = pageLimit !== undefined && rows.length > pageLimit;
    const pageRows = pageLimit === undefined ? rows : rows.slice(0, pageLimit);
    const lastRow = pageRows[pageRows.length - 1];
    const found = pageRows.flatMap((row): ConversationWindowRow[] => {
      const role = row.role;
      if ((role !== 'inbound' && role !== 'outbound') || row.textIsString !== true) {
        return [];
      }
      return [
        {
          id: row.id,
          at: toIso(row.at),
          role,
          ...(row.conversationId === null ? {} : { conversationId: row.conversationId }),
          ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
          ...(row.clientMessageId === null ? {} : { clientMessageId: row.clientMessageId }),
          ...(row.turnFailure === 'failed' || row.turnFailure === 'held'
            ? { turnFailure: row.turnFailure }
            : {}),
        },
      ];
    });
    return {
      rows: found,
      next: hasMore && lastRow !== undefined ? { id: lastRow.id, at: toIso(lastRow.at) } : null,
    };
  }

  // 題に要る本文の先頭だけを DB で切って返す（`left`・`length` はどちらもコードポイントで数える）。全文は運ばない
  async exchangeTextHeads(query: {
    ids: readonly string[];
    chars: number;
  }): Promise<ExchangeTextHead[]> {
    // NUL を含む id は DB に投げない（`get` と同じ）: text が NUL を受け付けずエラーになるため
    const ids = query.ids.filter((id) => !hasNul(id));
    if (ids.length === 0) return [];
    const hidden = await this.#hiddenSets(this.#db);
    const entry = journal.entry;
    const rows = await this.#db
      .select({
        id: journal.id,
        head: sql<string>`left(${entry}->>'text', ${query.chars}::int)`,
        truncated: sql<boolean>`length(${entry}->>'text') > ${query.chars}::int`,
        attachments: sql<number>`case when jsonb_typeof(${entry}->'attachments') = 'array' then jsonb_array_length(${entry}->'attachments') else 0 end`,
      })
      .from(journal)
      .where(
        and(
          hiddenConversationExchangeExcluded(hidden),
          inArray(journal.id, ids),
          eq(journal.type, 'exchange'),
          sql`(${entry}->>'with') = 'human'`,
          sql`jsonb_typeof(${entry}->'text') = 'string'`,
        ),
      );
    return rows.map((row) => ({
      id: row.id,
      head: row.head,
      truncated: row.truncated,
      attachments: toNumber(row.attachments),
    }));
  }

  // 墓標の件数と最後の `seq` の印。`humanReplies` の覚えと `#hiddenSets` の覚えが、読み直す時機の判定に共有する
  async #tombstoneSignature(db: Db): Promise<string | undefined> {
    return (
      await db
        .select({
          signature: sql<string>`count(*)::text || ':' || coalesce(max(${journal.seq}), 0)::text`,
        })
        .from(journal)
        .where(eq(journal.type, 'conversation_deleted'))
    )[0]?.signature;
  }

  // 外す行の集合を、墓標の印が変わったときだけ引き直して覚える（#5089）。読み出しのたびに印を1本だけ引く:
  // 別のプロセス（反映の入れ替えの間の旧デーモンなど）が墓標を積んでも取りこぼさないため、このプロセスの書き込みだけで覚えを捨てる形にしない。
  // 印を引いてから本体を打つまでの間に墓標が積まれると、その1回の読みだけ、消したばかりの行が見えうる:
  // 元は墓標の読みも本体と同じ1文（1つのスナップショット）の中だったので一貫していたが、いまは別の文になる。
  // 次の読みは印が変わっているので外れる。ふさがない: 墓標を積む側と読む側は元から順序を保証しない（積む直前に読んだ読みは、元でも消したばかりの行を見る）ため
  async #hiddenSets(db: Db, signature?: string): Promise<HiddenSets> {
    const current = signature ?? (await this.#tombstoneSignature(db)) ?? '';
    const cache = this.#hidden;
    if (cache !== null && cache.signature === current) return cache.sets;
    const deleted = await db
      .selectDistinct({ id: sql<string | null>`${journal.entry}->>'deletedConversationId'` })
      .from(journal)
      .where(eq(journal.type, 'conversation_deleted'));
    const named = await db
      .selectDistinct({ id: sql<string | null>`x.hid` })
      .from(sql`(${HIDDEN_ENTRY_IDS}) x`);
    const sets: HiddenSets = {
      // NULL を入れない: 配列に NULL が混ざると `<> ALL` が NULL になり、全行を落とすため
      deletedConversationIds: deleted.flatMap((row) => (row.id === null ? [] : [row.id])),
      hiddenEntryIds: named.flatMap((row) => (row.id === null ? [] : [row.id])),
    };
    this.#hidden = { signature: current, sets };
    return sets;
  }

  async clear(): Promise<number> {
    const removed = await this.#db.delete(journal).returning({ seq: journal.seq });
    // 消したら返答の覚えも捨てる（読み足しは前回より後ろしか見ないため）
    this.#humanReplies = null;
    this.#hidden = null;
    return removed.length;
  }
}

/** 読み出しから外す行の集合: 墓標（`conversation_deleted`）が消した会話の id と、墓標が名指しした行（`hiddenEntryIds`）の id */
interface HiddenSets {
  deletedConversationIds: string[];
  hiddenEntryIds: string[];
}

// 墓標のある会話の `exchange` と、墓標が名指しした行を外す条件。集合は器の側（`PgJournalStore.#hiddenSets`）で覚えて、配列のパラメータで渡す（#5089）。
// 条件の中に墓標を読む部分問い合わせを置かない: 墓標が増えると、名指しの集合の見積もり（墓標1行あたり約 102 行）がハッシュの作業領域を越え、
// 集合を外側の行ごとに読み直す計画に倒れて、日誌の読み出しの全部が崖のように遅くなる（偽の日誌 60 万行・墓標 1.5 万行で、会話一覧の窓 1.9 秒・humanReplies 約 50 秒）。
// 墓標が少なくても、読むたびに墓標の行を全部読む費用が付く。
// `NOT (… = ANY(…))` の形にしない: `conversationId` の無い `exchange` で NULL になり、行を落とす（元の `EXISTS` の形は「消されていない」と扱う）。
// 配列に NULL を入れない（`#hiddenSets`）: `<> ALL` が NULL になり、全行を落とすため。空の配列は何も外さない（`<> ALL('{}')` は真）。
// 外側の表の列は `sql.raw` で修飾して書く: drizzle は単表の select の列を修飾しない場合があるため。
// 配列は `sql.param` で包む: 素の配列は drizzle が `($1, $2, …)` の並びに開いてしまい、1つの配列のパラメータにならないため。
function hiddenConversationExchangeExcluded(sets: HiddenSets): SQL {
  const entry = sql.raw('"journal"."entry"');
  return sql`(${sql.raw('"journal"."type"')} <> 'exchange' OR (${entry}->>'conversationId') IS NULL OR (${entry}->>'conversationId') <> ALL(${sql.param(sets.deletedConversationIds)}::text[])) AND ${sql.raw('"journal"."id"')} <> ALL(${sql.param(sets.hiddenEntryIds)}::text[])`;
}

// 名指しした id の集合は、墓標から id へ開く。開き方は jsonb の `?` と同じ意味にする: 配列なら文字列の要素、オブジェクトなら鍵、文字列ならその値（数・真偽・null の要素は名指しに数えない）。
// 意味を JS へ書き写さない: SQL のまま1回だけ打ち、結果を配列で受けるため。NULL は返さない（`IS NOT NULL`）。
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
  return sql`(${journalSearchFieldMatchesSql(pattern, hasLetterCase(q) ? 'ilike' : 'like')})`;
}

/**
 * 語に大文字・小文字の別を持つ文字が在るか（#5126）。無ければ（日本語・数字・記号だけの語）、大文字・小文字を畳んでも畳まなくても当たる行は同じなので、
 * 畳む手間（`ILIKE`）を省いて `LIKE` で引く。100 万行の偽の日誌で、当たらない語が約 8 秒 → 約 4.5 秒になった。
 * 畳むと答えが変わるのは、本文の文字が畳まれて語の文字に重なるときだけで、畳んだ先（小文字）はそれ自体が別を持つ文字なので、別を持つ文字の無い語には起きない
 */
function hasLetterCase(q: string): boolean {
  return q.toLowerCase() !== q.toUpperCase();
}

// 欄名をバインド変数にしない: `jsonb ->> unknown` が `->>(jsonb,int)` と `->>(jsonb,text)` のどちらか決まらず落ちるため、`sql.raw` で埋める。
// 欄名を書き写さない: JS 側と同じ `JOURNAL_SEARCH_FIELDS` から作らないと、片方だけ直して見る欄がずれるため。
function journalSearchFieldMatchesSql(pattern: string, operator: 'ilike' | 'like'): SQL {
  return sql.join(
    JOURNAL_SEARCH_FIELDS.map(
      (field) =>
        sql`coalesce(${journal.entry}->>${sql.raw(`'${assertPlainFieldName(field)}'`)}, '') ${sql.raw(operator)} ${pattern} escape ${sql.raw("'\\'")}`,
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

import { randomUUID } from 'node:crypto';

import {
  journalEntrySchema,
  JournalAnchorNotFoundError,
  journalRowType,
  JOURNAL_SEARCH_FIELDS,
  noteDroppedJournalRow,
  noteDroppedJournalRowsSummary,
} from '@alteroid/core';
import type { JournalEntry, JournalEntryInput, JournalQuery, JournalStore } from '@alteroid/core';
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';

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
      // **`q` も `where` 節（＝ `limit` より前）で効かせる**（issue #250。`with` と
      // 同じ段）。組み立ては `journalSearchTextSql` / `likePattern`。
      ...(query.q === undefined ? [] : [journalSearchMatches(query.q)]),
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
    // **この呼び出し1回ぶんのローカルな器。** `PgJournalStore` のインスタンスへ
    // 状態を持たせない（この `for` でループが完結するので、これで足りる。
    // Issue #224）。
    const dropped = new Map<string, number>();
    for (const row of rows) {
      // 壊れた行があっても日誌全体を読めなくしない（fs 版と同じ扱い）。
      // ただし飛ばしたことは跡に残す——`get` と扱いを変えない。
      const parsed = journalEntrySchema.safeParse(row.entry);
      if (parsed.success) {
        found.push(parsed.data);
      } else {
        noteDroppedJournalRow(
          dropped,
          'unknown-shape',
          journalRowType(row.entry),
          byteLength(row.entry),
        );
      }
    }
    noteDroppedJournalRowsSummary(dropped);
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
    if (parsed.success) return parsed.data;
    // `list()` と同じ道具・同じ扱い（Issue #224）——1件だけでも「飛ばすが
    // 跡は残す」を崩さない。
    const dropped = new Map<string, number>();
    noteDroppedJournalRow(
      dropped,
      'unknown-shape',
      journalRowType(row.entry),
      byteLength(row.entry),
    );
    noteDroppedJournalRowsSummary(dropped);
    return null;
  }
}

/**
 * jsonb から読み出した（既に解かれた）値のバイト数を測る。**pg の駆動子は
 * `entry` を渡す時点で JSON を JS の値へ解いてしまっているので、fs 版
 * （生の行文字列の長さ）とは測り方が違う** —— 一度 `JSON.stringify` へ
 * 戻して、その UTF-8 バイト数を数える。**本文は載せない**という契約は保つ
 * （ここで作るのは数値だけで、跡へ渡す文字列そのものはここで作らない）。
 */
function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

/**
 * `q`（本文を語で探す。issue #250）を SQL の述語へ落とす。
 *
 * ## 意味論の決め方 —— `ILIKE`。全文検索は採らない
 *
 * **先例（`conversation_read` の `q`）が「大文字小文字を区別しない単純な部分
 * 一致」だと決めており、それをそのまま踏襲する**（`packages/core/src/store.ts`
 * の `JournalQuery.q`、`packages/core/src/conversation.ts` の
 * `searchExchanges`）。**PostgreSQL の全文検索（`tsvector` / `to_tsquery`）は
 * 部分一致ではない** —— 語に分けて正規化して照合するので、
 *
 * - 語の途中には当たらない（`"コミット"` で `"コミットメッセージ"` に当たらない）
 * - 既定の parser は日本語を語に割れない（割るには `pg_bigm` / `pgroonga` 等の
 *   拡張が要る。この repo の日誌はほぼ日本語である）
 * - **fs / インメモリの実装と答えが揃わない**（3実装で揃える契約が成り立たない）
 *
 * ⟹ **「pg だけ検索の意味論が違う」ことになるので採らない。** 探し方を増やす
 * より、3口で同じ答えが返るほうが効く（`searchExchanges` の doc と同じ判断）。
 *
 * ## 索引は張っていない（**「忘れた」ではなく、そう決めた**）
 *
 * `ILIKE '%…%'` は前方一致ではないので B-tree では効かない。効かせるなら
 * `pg_trgm` の GIN 索引（拡張の作成 + `migrate.ts` への追記）が要るが、
 * **今回は張っていない。** 理由:
 *
 * - **`q` は常に他の絞り（`types` / `since` / `until` / `after`）と同じ
 *   `where` 節に並ぶ。** 既存の `journal_at_idx` / `journal_type_at_idx` が
 *   先に効いた後の行にだけこの述語が当たる
 * - **`pg_trgm` は拡張である。** `create extension` が要るので、権限の要求が
 *   `migrate.ts` の現在の前提（`if not exists` の DDL だけ）より1段強くなる
 * - **測っていない値のために構造を足さない。** 実データでの遅さはまだ観測して
 *   いない（AGENTS.md「取れない軸に 0 の行を作らない」の裏面 —— 要ると分かって
 *   から張る）
 *
 * ⚠️ **遅いと分かったらここへ戻ること。** 張るなら `pg_trgm` + GIN を
 * `migrate.ts` の配列末尾へ足す（`migrate.ts` 冒頭の「⚠️ 古い鍵の `create` は
 * 配列から消す」に当たらない、純粋な追加である）。
 */
function journalSearchMatches(q: string): SQL {
  return sql`${journalSearchTextSql()} ilike ${likePattern(q)} escape ${sql.raw("'\\'")}`;
}

/**
 * 照合の対象になる文字列を SQL の式として組み立てる。
 *
 * **`JOURNAL_SEARCH_FIELDS` から組み立てる。欄名をここへ書き写さない** ——
 * JS 側（`journalSearchText`）と同じ定数・同じ順序・同じ区切り（改行1つ）で
 * 繋ぐことで、両者が作る文字列そのものが1バイトも違わなくなる
 * （`packages/core/src/journal-search.ts` の doc）。**書き写すと、片方だけ直して
 * 他方を忘れる形ができ、食い違いは特定の種別 × 特定の語のときだけ出る。**
 *
 * `coalesce(…, '')` で無い欄を空文字列にするのも JS 側と揃えるためである
 * （飛ばすと繋ぎ目の数が変わる）。改行は `chr(10)` で作る —— リテラルの
 * `E'\n'` は `standard_conforming_strings` の設定に意味が依存する。
 *
 * **欄名は SQL リテラルとして直に埋める**（`sql.raw`）。`->>` の右辺を
 * バインド変数にすると `jsonb ->> unknown` が `->>(jsonb,int)` と
 * `->>(jsonb,text)` のどちらか決まらず落ちる。埋める値は**このモジュールの
 * 定数だけ**で外から来ないが、それに依存しないよう下で形を検算している。
 */
function journalSearchTextSql(): SQL {
  return sql.join(
    JOURNAL_SEARCH_FIELDS.map(
      (field) =>
        sql`coalesce(${journal.entry}->>${sql.raw(`'${assertPlainFieldName(field)}'`)}, '')`,
    ),
    sql` || chr(10) || `,
  );
}

/**
 * 欄名が「英字だけ」であることを、SQL へ埋める直前に確かめる。
 *
 * **いま埋めている値はすべて `JOURNAL_SEARCH_FIELDS`（このリポジトリの定数）
 * から来ていて外から来ない。** それでも検算するのは、`sql.raw` が「安全な値
 * だけが来る」という**呼び出し側の性質**に頼っているからである —— 定数の
 * 出所が将来変わったとき、頼っている性質が消えたことは呼び出し側からは
 * 見えない。**判定できないという第3の状態を持たず、形が違ったら投げる**
 * （AGENTS.md「静かに失敗する道具」）。
 */
function assertPlainFieldName(field: string): string {
  if (!/^[A-Za-z]+$/.test(field)) {
    throw new Error(`日誌の検索対象の欄名が英字だけではない: ${JSON.stringify(field)}`);
  }
  return field;
}

/**
 * `q` を `ILIKE` のパターンへ包む。
 *
 * **`%` と `_` をワイルドカードとして通さない。** 塞がないと **pg だけ**が
 * `q: '50%'` で全件を返す（fs / インメモリは素の部分一致なので当たらない）
 * —— 3実装で揃える契約の一部そのものである（`JournalQuery.q` の doc、
 * `journal-search-contract.ts` が測る）。`\` 自身も先に倍にする（順序が逆だと、
 * 自分で足した `\` をもう一度倍にしてしまう）。
 *
 * **`ILIKE` の大文字小文字の畳み方は `lower()` と同じでロケールに依存し、
 * JS の `toLowerCase()` と完全には同じではない**（例: トルコ語ロケールの
 * `I`/`İ`）。日誌の本文（日本語・ASCII）では一致する。**ここは確認していない
 * 差である** —— 揃わない例が出たら、揃えるのは pg 側ではなく「照合を SQL から
 * 引き上げる」判断になる。
 */
function likePattern(q: string): string {
  return `%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

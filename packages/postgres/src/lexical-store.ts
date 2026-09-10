import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Ctx, LexicalFilter, LexicalHit, LexicalStore } from "@mnemora/core";
import type { Db } from "./client.js";

/**
 * `ts_rank_cd` の normalization 引数。PostgreSQL のドキュメント
 * （textsearch-controls）のビットの組み合わせのうち `32`（rank を `rank / (rank + 1)` で
 * 割って (0, 1) の範囲へ押し込める）だけを立てる。マネージャー指定。
 *
 * `LexicalHit.rank` は「adapter ごとに尺度が違う、同一クエリ・同一 adapter 内でしか
 * 比較できない値」（`@mnemora/core` の `LexicalHit.rank` の doc、ADR 0084 §5）なので、
 * この正規化の有無は契約上どちらでもよい——ここでは (0, 1) に収まる読みやすさのために
 * 選んでいるだけで、比較可能性を作るためではない。
 */
const TS_RANK_CD_NORMALIZATION = 32;

/**
 * `PostgresLexicalStore.search` が実際に打つ `SELECT` を組み立てる。
 *
 * **本体と `EXPLAIN` の歯が、同じものを使うために切り出してある。**
 * `packages/postgres/src/__tests__/lexical-store-index.test.ts` がこの関数の
 * 返り値をそのまま `EXPLAIN` する——テスト側に述語を書き写すと、本体の述語を
 * 直したときに歯だけが古い述語を測り続ける（`memory-store.ts` の
 * `buildRequeueEmbedTargetSelect` と同じ理由・同じ形）。
 *
 * `WHERE` の各条件は `PostgresVectorStore.search`（`vector-store.ts`）と同じ形・同じ
 * 意味に揃えてある（`LexicalFilter` の doc「`VectorFilter` と同じ絞りを、同じ意味で
 * 持つ」）。**`decayFloorAtAfter` は無い**——`LexicalFilter` がそもそも持っていない
 * フィールドである（`interfaces/lexical-store.ts` の doc、ADR 0011）。
 *
 * **🔴 本文側と query 側で、通す関数が違う。**どちらも
 * `migrations/0008_memories_lexical_index.sql` に在り、実測の根拠もそこに書いてある。
 *
 * | 側 | 関数 | 何をするか |
 * |---|---|---|
 * | 本文（索引式） | `mnemora_lexical_normalize` | ASCII の連なりの**前後に空白を入れる** |
 * | クエリ | `mnemora_lexical_query_terms` | **非 ASCII の連なりを空白に落とす** |
 *
 * **非対称なのは意図である。**両方に同じ関数を通すと、日本語の残りが1つの語彙になって
 * AND で結ばれ、`'PROJ-1234について前に何か言ってたっけ？'` が**1件も引けない**
 * （ADR 0084 §2.1 の実測。**変異試験で見つけた欠陥である**）。日本語の語は本文側でも
 * 文ごと1トークンになるので、**クエリに残しても真陽性を1件も生まない**——落として失うものが無い。
 *
 * **⚠ 正規表現をこのファイルに書き写さないこと。**片方だけ直してずれると、
 * 式索引が選ばれなくなる（静かに遅くなるだけで結果は変わらないため、
 * テストで検出しない限り気づけない）。
 *
 * `websearch_to_tsquery` が `query` から語彙を1つも作れない場合（例:
 * **日本語だけ**・空白だけの `query`）、返る `tsquery` は空になり、`@@` は常に `false`
 * を返す——`tenant_id`/`status` 等がどれだけ一致しても0件になる。これは
 * `LexicalStore.search` の契約に反しない（「引けなかった」であって「壊れた」ではない）。
 *
 * **⚠ `plainto_tsquery` に落とさないこと。**隣接を要求しない AND 意味論になるため、
 * 本文に `PROJ-1234 and TASK-5678` の2つが在ると `PROJ-5678` が偽陽性で一致する
 * （migrations/0008 のコメントに実測が在る）。歯: `lexical-store-identifier.test.ts`。
 */
export function buildLexicalSearchSelect(
  query: string,
  opts: { limit: number; filter: LexicalFilter },
): SQL {
  const conditions = [sql`tenant_id = ${opts.filter.tenantId}`];
  if (opts.filter.status !== undefined) {
    conditions.push(sql`status = ANY(${sql.param(opts.filter.status)}::text[])`);
  }
  if (opts.filter.subjectId !== undefined) {
    conditions.push(sql`subject_id = ${opts.filter.subjectId}`);
  }
  // ADR 0039: 実効時刻は COALESCE(occurred_at, recorded_at)。両端とも包含（>=/<=）
  // ——`PostgresVectorStore.search`（vector-store.ts）の period 絞りと同じ境界。
  if (opts.filter.occurredAfter !== undefined) {
    conditions.push(sql`COALESCE(occurred_at, recorded_at) >= ${opts.filter.occurredAfter}`);
  }
  if (opts.filter.occurredBefore !== undefined) {
    conditions.push(sql`COALESCE(occurred_at, recorded_at) <= ${opts.filter.occurredBefore}`);
  }
  // ADR 0056: 空配列は no-op。`length > 0` で番わないと `<> ALL('{}')` という常に真の
  // 条件が出るだけで実害は無いが、EXPLAIN を読みにくくするので出さない
  // （`vector-store.ts` と同じ判断）。
  if (
    opts.filter.excludeProvenanceKinds !== undefined &&
    opts.filter.excludeProvenanceKinds.length > 0
  ) {
    conditions.push(
      sql`provenance_kind <> ALL(${sql.param(opts.filter.excludeProvenanceKinds)}::text[])`,
    );
  }

  // 🔴 本文側と query 側で、通す関数が違う（migrations/0008_*.sql に実測の根拠が在る）。
  // 本文側は mnemora_lexical_normalize（ASCII の連なりの前後に空白を入れる）、
  // query 側は mnemora_lexical_query_terms（非 ASCII の連なりを空白に落とす）。
  // 日本語を残すと、その全体が1語彙になって AND で結ばれ、
  // 「PROJ-1234について前に何か言ってたっけ？」が1件も引けなくなる。
  const tsQuery = sql`websearch_to_tsquery('simple', mnemora_lexical_query_terms(${query}))`;
  conditions.push(sql`to_tsvector('simple', mnemora_lexical_normalize(content)) @@ ${tsQuery}`);
  const whereClause = sql.join(conditions, sql` AND `);

  return sql`
    SELECT
      id AS memory_id,
      ts_rank_cd(
        to_tsvector('simple', mnemora_lexical_normalize(content)),
        ${tsQuery},
        ${TS_RANK_CD_NORMALIZATION}
      ) AS rank
    FROM memories
    WHERE ${whereClause}
    ORDER BY rank DESC
    LIMIT ${opts.limit}
  `;
}

/**
 * `LexicalStore` の Postgres 実装（`@mnemora/core` の `interfaces/lexical-store.ts`、
 * ADR 0084、Issue #106）。
 *
 * `MemoryStore` が真実の源であり、この語彙索引（`migrations/0008_memories_lexical_index.sql`
 * の式索引）は `memories.content` の上に張った再構築可能な派生索引に過ぎない
 * （`VectorStore` と同じ非対称。`interfaces/lexical-store.ts` の doc）。
 * **書き込み口を持たない**——索引は `memories` への書き込みに自動で追随するため、
 * 同期の口が要らない（同 doc）。
 *
 * `search` の `ORDER BY` は `rank DESC`（`LexicalHit.rank` の doc: 大きいほど上位）。
 * `rank` の尺度は `ts_rank_cd` 固有であり、`VectorHit.distance`（コサイン距離）とは
 * 比較できない（ADR 0084 §5）。
 */
export class PostgresLexicalStore implements LexicalStore {
  constructor(private readonly db: Db) {}

  async search(
    ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter },
  ): Promise<LexicalHit[]> {
    const select = buildLexicalSearchSelect(query, opts);
    const result = await this.db.execute(select);
    return result.rows.map((row) => {
      const r = row as unknown as { memory_id: string; rank: number };
      return { memoryId: r.memory_id, rank: r.rank };
    });
  }
}

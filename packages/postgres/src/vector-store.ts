import { sql } from "drizzle-orm";
import type {
  Ctx,
  EmbeddingSpaceId,
  MemoryId,
  VectorFilter,
  VectorHit,
  VectorStore,
} from "@mnemora/core";
import type { Db } from "./client.js";
import { assertSafeIdentifier, embeddingSpaceTableName } from "./embedding-space-table.js";
import { isUuidLike } from "./mapping.js";

/** `number[]` を pgvector のテキスト表現（`[1,2,3]`）に変換する。 */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * `VectorStore` の Postgres 実装（docs/architecture.md §5.2、pgvector）。
 *
 * 契約（docs/decisions/0003-memorystore-vs-vectorstore.md）: `MemoryStore` が真実の源であり、
 * `VectorStore` はここに実装があっても再構築可能な派生索引に留まる。
 *
 * `search` の `ORDER BY` には距離演算子の結果をそのまま昇順で書く（式にしない）。
 * これは docs/memory-model.md §10「規約」であり、`testkit`/`packages/postgres` の
 * `EXPLAIN` 検査対象そのものである。
 *
 * テーブルは事前に `registerEmbeddingSpace`（`./vector-space.ts`）で作られている前提。
 * 未登録の空間に対して呼ぶと Postgres の `relation does not exist` エラーになる
 * （黙って何もしない、より安全な失敗の仕方）。
 */
export class PostgresVectorStore implements VectorStore {
  constructor(private readonly db: Db) {}

  async upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: MemoryId,
    vector: number[],
  ): Promise<void> {
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    await this.db.execute(sql`
      INSERT INTO ${sql.identifier(table)} (tenant_id, memory_id, embedding, model, created_at)
      VALUES (${ctx.tenantId}, ${memoryId}, ${toVectorLiteral(vector)}::vector, ${space.model}, now())
      ON CONFLICT (tenant_id, memory_id)
      DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, created_at = now()
    `);
  }

  async search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    const queryLiteral = toVectorLiteral(query);

    const conditions = [sql`e.tenant_id = ${opts.filter.tenantId}`];
    if (opts.filter.status !== undefined) {
      conditions.push(sql`m.status = ANY(${sql.param(opts.filter.status)}::text[])`);
    }
    if (opts.filter.decayFloorAtAfter !== undefined) {
      conditions.push(sql`m.decay_floor_at > ${opts.filter.decayFloorAtAfter}`);
    }
    if (opts.filter.subjectId !== undefined) {
      conditions.push(sql`m.subject_id = ${opts.filter.subjectId}`);
    }
    // ADR 0059: period の押し下げ。比較対象は COALESCE(occurred_at, recorded_at)
    // （ADR 0039 が定義した「実効時刻」——4箇所あった判定規則の5箇所目)。両端とも包含
    // （`>=`/`<=`）——`VectorFilter.occurredAfter`/`occurredBefore` の doc、および
    // 既存の厳密経路（`memory-store.ts` の `aggregateScope`）と同じ境界の含み方に揃える。
    if (opts.filter.occurredAfter !== undefined) {
      conditions.push(sql`COALESCE(m.occurred_at, m.recorded_at) >= ${opts.filter.occurredAfter}`);
    }
    if (opts.filter.occurredBefore !== undefined) {
      conditions.push(sql`COALESCE(m.occurred_at, m.recorded_at) <= ${opts.filter.occurredBefore}`);
    }
    // ADR 0056: 空配列は no-op（`VectorFilter.excludeProvenanceKinds` の doc 参照）。
    // `length > 0` で番わないと `<> ALL('{}')` という無駄な条件が出る——常に真になり実害は
    // 無いが（`<> ALL` は空配列に対して真）、`EXPLAIN` を読みにくくするので出さない。
    if (
      opts.filter.excludeProvenanceKinds !== undefined &&
      opts.filter.excludeProvenanceKinds.length > 0
    ) {
      conditions.push(
        sql`m.provenance_kind <> ALL(${sql.param(opts.filter.excludeProvenanceKinds)}::text[])`,
      );
    }
    const whereClause = sql.join(conditions, sql` AND `);

    // ORDER BY には距離演算子の結果をそのまま昇順で置く（式にしない。docs/recall.md §3）。
    const result = await this.db.execute(sql`
      SELECT e.memory_id AS memory_id, e.embedding <=> ${queryLiteral}::vector AS distance
      FROM ${sql.identifier(table)} e
      JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id
      WHERE ${whereClause}
      ORDER BY e.embedding <=> ${queryLiteral}::vector
      LIMIT ${opts.limit}
    `);
    return result.rows.map((row) => {
      const r = row as unknown as { memory_id: string; distance: number };
      return { memoryId: r.memory_id, distance: r.distance };
    });
  }

  async delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void> {
    // memory_id 列は uuid 型。この口の契約は「無い == 何もしない」（void、族A）なので、
    // 形式が壊れた memoryId もクエリを投げる前に同じ no-op へ寄せる——DELETE は
    // 0行に終わるだけで実害は無いが、素通しすると invalid input syntax for type uuid が
    // 飛んでしまい「無い」と「壊れた入力」の区別が呼び出し側に漏れる
    // （mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(memoryId)) {
      return;
    }
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    await this.db.execute(sql`
      DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${memoryId}
    `);
  }
}

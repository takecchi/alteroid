import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus } from "../memory.js";
import type { ProvenanceKind } from "../provenance.js";

/**
 * `search` の `filter` は索引で表現できる形（等値・単調な範囲比較）に限る
 * （docs/architecture.md §5.2）。
 *
 * **各フィールドは adapter が実際に適用しなければならない（ADR 0034）。**
 * 「絞ってもよいが絞らなくてもよい」という緩い契約ではない——`packages/testkit` の
 * `vector-store-conformance.ts` がこれを adapter 非依存の歯として検査する
 * （`status` に無いものは返らない・一致しない `subjectId` は返らない・
 * `decayFloorAtAfter` 以前のものは返らない・`excludeProvenanceKinds` に在る kind は
 * 返らない、を同一の適合テストで postgres / in-memory 両方に対して走らせる）。
 *
 * **⚠ 後段の多層防御は、ここの全フィールドを覆ってはいない。**
 * `packages/core/src/recall-runtime.ts` は段1のあとに `subjectId`・`excludeProvenanceKinds`
 * （と、`VectorFilter` に無い period）を改めて見るが、**`status` と `decayFloorAtAfter` は
 * 見ない**。⟹ `status` と `decayFloorAtAfter` については、ここの契約を adapter が守ることが
 * **唯一の防衛線**である（実測: `FakeVectorStore` の `status` の絞りを落とす変異で、
 * `recall-pipeline.test.ts` の既存の歯が実際に赤くなる。`subjectId` を落とす変異では
 * 赤くならない——後段が救うため）。`subjectId` と `excludeProvenanceKinds` は後段にも
 * 同じ絞りが残るので、adapter がこの契約を落としても後段が結果の正しさを救う
 * （ADR 0056）——ただしこれは「段1で絞らなくてよい」ことの根拠ではない。段1の絞りは
 * over-fetch の窓（k'）を無駄にしないための最適化であり、後段フィルタが在ることは、
 * どの場合も「filter を無視してよい」ことの根拠ではない。
 */
export interface VectorFilter {
  tenantId: string;
  status?: MemoryStatus[];
  /**
   * **狭義の `>`。** `decayFloorAt` が境界と*ちょうど同じ* Memory は含まれない
   * （`packages/postgres/src/vector-store.ts` の `m.decay_floor_at > ${decayFloorAtAfter}`
   * がこの意味論の基準）。`>=` にすると忘却の境界上にある記憶が想起され続けてしまう
   * （ADR 0004 の「忘却をクエリ時に算出する」設計と整合させるため）。
   */
  decayFloorAtAfter?: Date;
  /**
   * subject の等値一致（`docs/vision.md` の「Tenant と Subject を混同しない」区別における
   * テナント内の整理の単位）。等値比較なので上のクラス doc の「索引で表現できる形」に
   * そのまま当たる——`period`（`occurredAfter`/`occurredBefore`）のような連続値の範囲比較とは
   * 事情が異なる（`docs/recall.md` が指摘する partial index の離散値向き制約は period 側の話）。
   */
  subjectId?: string;
  /**
   * **除外**の列挙である（ADR 0056）。**上の `status` とは向きが逆**——`status` は
   * 「この配列に*在る*ものだけ通す」包含の列挙だが、`excludeProvenanceKinds` は
   * 「この配列に*在る*ものを落とす」除外の列挙。`RecallQuery.excludeProvenanceKinds`
   * （`packages/core/src/recall.ts`）と同じ語彙・同じ向きに揃えてある。
   *
   * `ProvenanceKind` は5値の閉じた離散値であり、`provenance_kind` は独立の列
   * （`packages/postgres/migrations/0001_init.sql`）なので等値比較で足りる——
   * 上のクラス doc の「索引で表現できる形」にそのまま当たる。`period` のような
   * 連続値の範囲比較とは事情が異なる（ADR 0023 が `period` を段1に降ろさなかった理由は
   * ここには当たらない。詳細は ADR 0056）。
   *
   * **⚠ `undefined` と空配列 `[]` はどちらも no-op（何も除外しない）。** これは
   * 上の `status` とは非対称である——`status: []` は SQL の `= ANY('{}')` に翻訳され
   * *何にも一致しない*（全件を除外する）が、`excludeProvenanceKinds: []` は
   * 「除外する kind が0個」という意味であり全件を通す。適合テストの歯
   * （`vector-store-conformance.ts`）がこの非対称を固定している。
   */
  excludeProvenanceKinds?: ProvenanceKind[];
}

export interface VectorHit {
  memoryId: MemoryId;
  /**
   * **コサイン距離（`1 - cosine similarity`）。** 他の距離関数（ユークリッド距離等）ではない
   * ——`packages/postgres/src/vector-space.ts` の HNSW 索引が `vector_cosine_ops` を明示しており
   * （pgvector の `<=>` 演算子＝コサイン距離）、[ADR 0033](../../../../docs/decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md)
   * が「距離はコサイン」を実測として記録し、`packages/core/src/__tests__/runtime-fakes.ts` の
   * `FakeVectorStore` も `cosineDistance` を使っている。下流（`recall-runtime.ts`）は
   * `1 - distance` を `similarity` として扱っており、これはコサイン距離の場合にのみ
   * 「同一なら1、無関係なら0付近」という意味を持つ——adapter が別の距離関数を返すと
   * 下流のスコアリングの意味が壊れる。
   *
   * **⚠ 範囲は 0〜1 ではない。** コサイン距離は逆向き（cosine similarity = -1）のとき
   * 最大 2 まで出る（[ADR 0036](../../../../docs/decisions/0036-clamp-freshness-at-one.md) が
   * `similarity = 1 - distance` が −1 まで負になりうることを実測として記録している）。
   *
   * 適合テスト（`packages/testkit/src/vector-store-conformance.ts`）がこの契約を
   * adapter 非依存の歯として検査する。
   */
  distance: number;
}

/**
 * VectorStore — Phase 1（docs/architecture.md §5.2）。
 *
 * 契約:
 * - MemoryStore が真実の源であり、VectorStore は再構築可能な派生索引である
 *   （非対称。VectorStore を失っても MemoryStore から再 embed して復旧できるが逆はできない）。
 * - `ORDER BY` を距離式にしない、という規約は adapter 実装の責務であり、`testkit` は
 *   `EXPLAIN` で索引が使われることを検査する。
 * - 埋め込みが未完了の Memory は `Memory.embeddingStatus` を持ち、recall は
 *   `omitted.kind = 'not_indexed'` としてこれを報告する。
 */
export interface VectorStore {
  upsert(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId, vector: number[]): Promise<void>;
  search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]>;
  /**
   * 対象の vector が存在しなければ何もしない（`void`、べき等）。`memoryId` が adapter
   * の期待する形式でない場合も同じ「何もしない」という結果になる。core の `MemoryId` は
   * 単なる `string` であり形式を強制しないため、adapter が期待する形式に合わない
   * `memoryId` は「存在しない」の一種として扱う（`packages/postgres/src/mapping.ts` の
   * `isUuidLike` の doc コメント参照）。
   */
  delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void>;
}

import type {
  Ctx,
  EmbeddingSpaceId,
  MemoryId,
  VectorFilter,
  VectorHit,
  VectorStore,
} from "@mnemora/core";
import type { InMemoryMemoryStore } from "./in-memory-memory-store.js";

interface Entry {
  tenantId: string;
  memoryId: MemoryId;
  vector: number[];
}

/**
 * `VectorHit.distance` の契約（`packages/core/src/interfaces/vector-store.ts`）に合わせて
 * コサイン距離を返す。以前はユークリッド距離だったが、`packages/postgres/src/vector-store.ts`
 * はコサイン距離（pgvector の `<=>`、`vector_cosine_ops`）を使っており、
 * `recall-runtime.ts` は `1 - distance` を similarity として扱う——ユークリッド距離のままでは
 * その意味論が崩れ、in-memory と postgres で「同じ入力に別の順序」が出てしまう。
 *
 * `packages/core/src/__tests__/runtime-fakes.ts` の `FakeVectorStore` に全く同じ実装
 * （`cosineDistance`）が既にあるが、`packages/testkit` は `packages/core` の**テストファイル**を
 * import できない（`packages/core` の実行時依存が zod のみであることを壊すことになる）ため、
 * ここで意図して重複させている。
 *
 * ゼロベクトルはコサインが未定義（0/0）になる。
 *
 * **🔴 訂正（[ADR 0040](../../../../docs/decisions/0040-zero-vector-never-returned.md)）**:
 * ここには以前「pgvector の `<=>` はゼロベクトルに対してエラーを返す」と書いてあったが、
 * **それは誤りだった。実測すると `NaN` を返す**（pgvector 0.8.2。両引数位置・両方ゼロ・
 * `ORDER BY` の中でも例外にならない）。
 *
 * そしてこの実装は「無関係（距離1）」を返していた。**⟹ 同じ呼び出しが adapter によって
 * 別の答えになっていた**——`similarity = 1 - distance` なので in-memory は
 * `similarity = 0`、Postgres は `NaN`。既定の `scoreThreshold`（0.1）では
 * どちらも落ちるが、**呼び出し側が `scoreThreshold` を 0 以下にすると
 * in-memory だけが候補を返していた。**
 *
 * **契約（ADR 0040）: ゼロベクトルが絡む候補は `recall()` の結果に出ない。**
 * `NaN` はどんな数との比較も false になるので、**どんな `scoreThreshold` でも通らない。**
 * `Infinity` は `scoreThreshold = -Infinity` で通ってしまうため使わない。
 */
function cosineDistance(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) {
    // ⚠ 0 でも 1 でも Infinity でもなく NaN を返す。理由は上の doc を参照
    //（どんな閾値と比べても通らない値でなければ契約を満たせない）。
    return Number.NaN;
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
}

/**
 * `VectorStore` のインメモリ・プレースホルダ実装。索引・pgvector を模さない
 * 最小実装であり、`packages/testkit` の適合テストを実行できることを示すためだけのもの。
 *
 * **`memoryStore` を必須のコンストラクタ引数にしている（省略不可）。** `status` /
 * `subjectId` / `decayFloorAt` は Memory の属性であって、ベクトルの属性ではない
 * （`VectorFilter` — `packages/core/src/interfaces/vector-store.ts`）。
 * `packages/postgres/src/vector-store.ts` はこれを `JOIN memories m` で得ている
 * ——ADR 0003（`MemoryStore` が真実の源であり、`VectorStore` は再構築可能な派生索引で
 * あるという非対称）をそのまま実装した形であり、Postgres 側は外部キー
 * （`memory_id → memories(id)`）でこの非対称を強制してもいる。in-memory 実装が
 * `InMemoryMemoryStore` を参照するのは、同じ非対称を写しただけである
 * （`InMemoryOutboxStore` が `InMemoryMemoryStore.outboxJobs` を共有参照で受け取るのと
 * 同じ形、同じ理由）。
 *
 * **省略可能にしなかった理由（ADR 0034）**: 省略できると「filter を実際に検査できる
 * adapter」と「検査できない（＝常に無視しても壊れない）adapter」が同じ緑色の出力に
 * なる。このリポジトリは ADR 0011/0025/0027/0028 で同じ族の失敗
 * （名乗れる以上の精度を主張する）を繰り返しており、ここでも繰り返さない。
 */
export class InMemoryVectorStore implements VectorStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly memoryStore: InMemoryMemoryStore) {}

  private key(space: EmbeddingSpaceId, tenantId: string, memoryId: MemoryId): string {
    return `${space.provider}:${space.model}:${space.dimensions}:${tenantId}:${memoryId}`;
  }

  async upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: MemoryId,
    vector: number[],
  ): Promise<void> {
    // 外部キー相当（ADR 0047）: `memory_embeddings_<space>.memory_id → memories(id)`。
    // `search` は既に `this.memoryStore.get(...)` を真実の源として引いている
    // （クラス doc 参照）——書き込み側（upsert）でも同じ非対称を強制する。
    const memory = await this.memoryStore.get(ctx, memoryId);
    if (!memory) {
      throw new Error(`InMemoryVectorStore: memory not found: ${memoryId}`);
    }
    this.entries.set(this.key(space, ctx.tenantId, memoryId), {
      tenantId: ctx.tenantId,
      memoryId,
      vector,
    });
  }

  async search(
    _ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    // 索引を模す prefix は space（provider/model/dimensions）だけで絞る。
    // テナント分離は `opts.filter.tenantId` の一致だけで行う——これが
    // `VectorStore.search` の実際の契約（docs/architecture.md §5.2: filter は
    // 索引で表現できる形に限る）であり、ctx.tenantId で二重に絞ってしまうと
    // 「filter.tenantId を無視しても壊れない」という誤ったプレースホルダになる。
    const prefix = `${space.provider}:${space.model}:${space.dimensions}:`;
    const memoryCtx: Ctx = { tenantId: opts.filter.tenantId };
    const hits: VectorHit[] = [];
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      if (entry.tenantId !== opts.filter.tenantId) {
        continue;
      }
      // `status` / `subjectId` / `decayFloorAt` は Memory の属性であり、`memories`
      // 相当（`this.memoryStore`）を引かないと見られない（クラス doc 参照）。
      // Postgres 実装の `JOIN memories m ON m.id = e.memory_id` に対応する一段。
      const memory = await this.memoryStore.get(memoryCtx, entry.memoryId);
      if (!memory) {
        // Postgres の外部キー制約に対応する扱い——真実の源に無い vector は返さない。
        continue;
      }
      if (opts.filter.status !== undefined && !opts.filter.status.includes(memory.status)) {
        continue;
      }
      if (opts.filter.subjectId !== undefined && memory.subjectId !== opts.filter.subjectId) {
        continue;
      }
      if (
        opts.filter.decayFloorAtAfter !== undefined &&
        !(memory.decayFloorAt > opts.filter.decayFloorAtAfter)
      ) {
        // 狭義の `>`（境界とちょうど同じものは除外）。postgres 実装の
        // `m.decay_floor_at > ${decayFloorAtAfter}` と揃える。
        continue;
      }
      // ADR 0056: 除外の列挙（status とは向きが逆）。`undefined`/空配列は no-op
      // （`VectorFilter.excludeProvenanceKinds` の doc 参照）。
      if (
        opts.filter.excludeProvenanceKinds !== undefined &&
        opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)
      ) {
        continue;
      }
      // ADR 0059: period（両端とも包含、`>=`/`<=`）。比較対象は
      // `occurredAt ?? recordedAt`——postgres 実装の
      // `COALESCE(m.occurred_at, m.recorded_at)` に対応する一段（ADR 0039 の実効時刻）。
      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      if (
        opts.filter.occurredAfter !== undefined &&
        !(effectiveTime >= opts.filter.occurredAfter)
      ) {
        continue;
      }
      if (
        opts.filter.occurredBefore !== undefined &&
        !(effectiveTime <= opts.filter.occurredBefore)
      ) {
        continue;
      }
      hits.push({ memoryId: entry.memoryId, distance: cosineDistance(query, entry.vector) });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits.slice(0, opts.limit);
  }

  async delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void> {
    this.entries.delete(this.key(space, ctx.tenantId, memoryId));
  }
}

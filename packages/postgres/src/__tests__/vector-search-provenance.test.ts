import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture, buildProvenanceFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
  seededRandom,
} from "./test-db.js";

const TABLE = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);

/**
 * ADR 0056 の段1押し下げ（`excludeProvenanceKinds`）を、`vector-search-subject.test.ts`
 * （ADR 0023、`subjectId` の押し下げ）と同型で実測する。
 *
 * **使う kind**: crowd（除外対象）は `"consolidated"`、small（残す対象）は `"imported"`
 * （`buildNewMemoryFixture` の既定）。`"inferred"`/`"stated"` は使わない——CHECK 制約
 * （`packages/postgres/migrations/0001_init.sql:68`）により実在の Observation を指す
 * `source_observation_id` が要り、この歯にはその設定が要らない負荷である
 * （`buildProvenanceFixture` の doc コメント参照）。除外の向き自体はどの kind でも同じ
 * メカニズムなので、実運用の主用途（`inferred` の除外、roadmap.md §5.5）を測るものではなく、
 * **段1へ押し下げたことでオーバーフェッチの窓が救われるという構造そのもの**を測る。
 *
 * ⚠ `subjectId` との選択性の違い: `subject_id` は高選択性（500件中 crowd/small で分かれる）
 * だったが、`provenance_kind` は離散5値で `<> ALL` は除外なので典型的には候補の大半が残る
 * ——歯Bで低選択性側の実測を別途行う。
 */

const TENANT = "provenance-filter-tenant";
const CROWD_COUNT = 500;
const SMALL_COUNT = 3;
const LIMIT = 40;
const QUERY_VECTOR: number[] = [1, 0, 0];

async function seedCrowdAndSmall(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  pool: Pool,
): Promise<{ crowdIds: string[]; smallIds: string[] }> {
  const rand = seededRandom(20260907);
  const noisy = (base: number[], scale: number): number[] =>
    base.map((v) => v + (rand() - 0.5) * scale);

  const crowdIds: string[] = [];
  for (let i = 0; i < CROWD_COUNT; i += 1) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        provenance: buildProvenanceFixture("consolidated"),
      }),
    );
    // クエリベクトルのすぐ近く（cosine 距離 ~0）に大量に置く——除外対象の kind。
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, noisy(QUERY_VECTOR, 0.02));
    crowdIds.push(memory.id);
  }

  const smallIds: string[] = [];
  for (let i = 0; i < SMALL_COUNT; i += 1) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        provenance: buildProvenanceFixture("imported"),
      }),
    );
    // クエリベクトルから遠く（cosine 距離 ~2、ほぼ正反対）に少数だけ置く——残す対象の kind。
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, noisy([-1, 0, 0], 0.02));
    smallIds.push(memory.id);
  }

  // ANALYZE: 統計情報が無い/古いと HNSW 索引が選ばれないことがある（vector-search-hnsw.test.ts と同じ理由）。
  await pool.query(`ANALYZE ${TABLE}`);
  await pool.query("ANALYZE memories");

  return { crowdIds, smallIds };
}

describe("PostgresVectorStore.search — excludeProvenanceKinds が段1に効くこと（歯A）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("excludeProvenanceKinds で絞ると窓は small の3件になり、絞らないと窓は crowd(40件)で埋まり small は0件になる", async () => {
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const { smallIds } = await seedCrowdAndSmall(memoryStore, vectorStore, ctx, pool);

    // 修正前の段1呼び出しと同じ形（excludeProvenanceKinds を渡さない）。
    const withoutFilter = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, QUERY_VECTOR, {
      limit: LIMIT,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });
    expect(withoutFilter).toHaveLength(40);
    const smallIdSet = new Set(smallIds);
    const smallHitsWithoutFilter = withoutFilter.filter((h) => smallIdSet.has(h.memoryId));
    expect(smallHitsWithoutFilter).toHaveLength(0);

    // 修正後: excludeProvenanceKinds: ["consolidated"] を渡す。
    const withFilter = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, QUERY_VECTOR, {
      limit: LIMIT,
      filter: {
        tenantId: TENANT,
        status: ["active", "contested"],
        excludeProvenanceKinds: ["consolidated"],
      },
    });
    expect(withFilter).toHaveLength(3);
    expect(new Set(withFilter.map((h) => h.memoryId))).toEqual(smallIdSet);
  }, 120_000);
});

/**
 * 歯B（EXPLAIN）: `m.provenance_kind <> ALL($x)` を足した形の段1クエリで、プランナが
 * 実際に何を選ぶか。
 *
 * **⚠ この歯は「HNSW が使われる」とも「HNSW が使われない」とも主張しない。** どちらの
 * 主張も、この作業環境（PostgreSQL が無い）では測れない推測にしかならない。
 * `vector-search-subject.test.ts` の歯Bは「`subject_id = $x` を足すとプランナが HNSW を
 * 捨てる」という、CI の実測で確定した強い主張を書いている——しかしそれは `subject_id` が
 * **高選択性**（実測データでは 3,000行・100 subject ⟹ 1条件で約1/100に絞れる）だから成り立つ
 * 主張である。`provenance_kind` は**低選択性**の離散5値で、しかも `<> ALL` は*除外*なので
 * 典型的には候補の大半が残る——選択性が逆なので、`subject_id` の実測結果をそのまま
 * 転用できない。**プランナがどちらを選ぶかは、この歯を書いている時点でも次の CI 実行までも
 * 分からない。**
 *
 * ⟹ ここでは選択性に依存しない、壊れにくい不変だけを検査する:
 * - `memories` 本体の `Seq Scan`（テナント全体を素通し）が現れないこと。
 *   `idx_memories_recall_gate`（`tenant_id, status, decay_floor_at`）が使えるはずで、
 *   `provenance_kind` の条件が追加されても `memories` を全走査する理由にはならない
 *   ——**この不変は選択性に関わらず成り立つはずである**（`provenance_kind` を絞る条件が
 *   `memories` へのアクセス経路を悪化させる理由がない。列は同じテーブルの別列であり、
 *   条件を足すことは既存の索引アクセスを妨げない）。
 * - `provenance_kind` の条件が実際にプランへ現れること（`Filter` か `Index Cond` の
 *   どちらかに `provenance_kind` という文字列が出る）——条件が黙って落ちていないことの確認。
 *
 * **プランそのものは `console.log` で CI ログに残す**（次にこの歯を読む人が実際の
 * プランを見られるようにするため。断定的なアサーションより、生のプランを残すことを
 * 優先する——マネージャーの指示）。
 *
 * **確かめていないこと**: この歯を実行した CI run は、本 PR の時点でまだ存在しない
 * （この作業環境に PostgreSQL/`DATABASE_URL` が無いため、一度も実行していない）。
 * ⟹ 上のアサーションが実際に通るかどうかも含めて、**次の CI 実行が唯一の実測経路**である。
 * 通らなかった場合、それは「この不変も選択性に依存していた」という発見になりうる——
 * その場合はさらに弱いアサーションへ書き直す必要がある。
 */
const EXPLAIN_TENANT = "provenance-explain-tenant";
const EXPLAIN_ROW_COUNT = 3000;

async function seedForExplain(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  pool: Pool,
) {
  const rand = seededRandom(20260907 + 1);
  for (let i = 0; i < EXPLAIN_ROW_COUNT; i += 1) {
    // 5分の1を "consolidated"（除外対象）、残りを "imported"（既定）にする——
    // provenance_kind の低選択性（離散5値、除外は候補の大半を残す）を再現する分布。
    const kind = i % 5 === 0 ? "consolidated" : "imported";
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, provenance: buildProvenanceFixture(kind) }),
    );
    const vector = [rand(), rand(), rand()];
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
  }
  // 統計情報が無い/古いままだと、プランナが誤った行数見積もりで意図しない索引を選ぶ
  // （vector-search-hnsw.test.ts の実測コメントと同じ理由）。
  await pool.query(`ANALYZE ${TABLE}`);
  await pool.query("ANALYZE memories");
}

describe("PostgresVectorStore.search — excludeProvenanceKinds を足すとプランナが何を選ぶか（歯B、断定しない）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("m.provenance_kind <> ALL($x) を足しても、memories 本体の Seq Scan にはならず、条件はプランに現れる", async () => {
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: EXPLAIN_TENANT };
    await seedForExplain(memoryStore, vectorStore, ctx, pool);

    const explainResult = await pool.query(
      `EXPLAIN (FORMAT TEXT)
         SELECT e.memory_id AS memory_id, e.embedding <=> '[0.5,0.5,0.5]'::vector AS distance
         FROM ${TABLE} e
         JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id
         WHERE e.tenant_id = $1 AND m.status = ANY($2::text[]) AND m.provenance_kind <> ALL($3::text[])
         ORDER BY e.embedding <=> '[0.5,0.5,0.5]'::vector
         LIMIT 40`,
      [EXPLAIN_TENANT, ["active", "contested"], ["consolidated"]],
    );
    const plan = explainResult.rows
      .map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"])
      .join("\n");
    // 次にこの歯を読む人が実際のプランを見られるよう、CI ログに残す（アサーションでは断定しない）。
    console.log("[vector-search-provenance] EXPLAIN plan:\n" + plan);

    // 弱い不変その1: memories 本体を全走査していない（テーブル名の直後に Seq Scan on memories
    // が来る形。JOIN 先の埋め込みテーブルの Seq Scan はここでは問わない——歯Aが結果の
    // 正しさを、この歯はプランの壊れにくい形だけを押さえる）。
    expect(plan).not.toMatch(/Seq Scan on memories\b/);
    // 弱い不変その2: provenance_kind の条件が黙って落ちていない。
    expect(plan).toMatch(/provenance_kind/);
  }, 120_000);
});

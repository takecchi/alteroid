import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { DeterministicEmbeddingProvider, DeterministicLLMProvider } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { sha256Hex } from "../content-hash.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * roadmap.md 段階3の完了条件を、本物の Postgres に対して実際に往復させて確認する
 * （PR 本文「擬似物の扱い」参照）。
 *
 * **正直に書く**: ここで使う `LLMProvider` / `EmbeddingProvider` は
 * `@mnemora/testkit` の決定的な擬似実装（`DeterministicLLMProvider` /
 * `DeterministicEmbeddingProvider`）である。本物の OpenAI を CI から叩くことはできない
 * （API キーが無い）ため、このテストが検査しているのは「runtime → MemoryStore →
 * VectorStore → outbox という配線が実際の Postgres に対して正しく動くか」であり、
 * 「LLM/埋め込みの抽出結果そのものの品質」ではない。後者は `packages/openai` の
 * 翻訳検査（zod → JSON Schema）と、`OPENAI_API_KEY` がある場合だけ走る live テストに
 * 分離してある。
 */
function buildRuntime() {
  return getTestClient().then(({ db }) => {
    return createRuntime({
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: new DeterministicLLMProvider(),
      embeddingProvider: new DeterministicEmbeddingProvider(TEST_EMBEDDING_SPACE),
      hashContent: sha256Hex,
    });
  });
}

describe("observe → recall 前段の往復（roadmap.md 段階3、本物の Postgres）", () => {
  it("observe(sync) → observations 行 → memories 行 → tick(embed) → memory_embeddings 行 → embeddingStatus='ready'", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const runtime = await buildRuntime();
    const ctx: Ctx = { tenantId: "tenant-roundtrip" };

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "DB往復検証用の発話です",
      speaker: "tester",
    });

    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(1);

    // 1. observations 行
    const observationRows = await db.execute(sql`
      SELECT * FROM observations WHERE id = ${result.observationId}
    `);
    expect(observationRows.rows).toHaveLength(1);

    // 2. memories 行（digest は NOT NULL 制約を満たしている＝ INSERT 自体が成功している）
    const memoryId = result.memoryIds[0]!;
    const memoryRows = await db.execute(sql`
      SELECT * FROM memories WHERE id = ${memoryId}
    `);
    expect(memoryRows.rows).toHaveLength(1);
    const memoryRow = memoryRows.rows[0] as unknown as {
      digest: string;
      content: string;
      embedding_status: string;
      source_observation_id: string;
    };
    expect(memoryRow.digest.length).toBeGreaterThan(0);
    expect(memoryRow.content).toBe("DB往復検証用の発話です");
    expect(memoryRow.embedding_status).toBe("pending");
    expect(memoryRow.source_observation_id).toBe(result.observationId);

    // 3. embed ジョブが outbox に積まれている（sync 抽出でも embed は常に非同期）
    const outboxRows = await db.execute(sql`
      SELECT * FROM outbox WHERE tenant_id = ${ctx.tenantId} AND kind = 'embed' AND completed_at IS NULL
    `);
    expect(outboxRows.rows).toHaveLength(1);

    // 4. tick で embed ジョブを消化する
    // このテストはリースの境界を検査しない(それは outbox-claim-lease-index.test.ts /
    // outbox-store-conformance.ts の役目)ので、十分に長く固定した値を使う。
    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(tickResult).toEqual({ processed: 1, failed: 0, unsupported: [] });

    // 5. embeddingStatus が 'ready' に遷移している
    const memoryStore = new PostgresMemoryStore(db);
    const updatedMemory = await memoryStore.get(ctx, memoryId);
    expect(updatedMemory?.embeddingStatus).toBe("ready");

    // 6. memory_embeddings_<space> に実際に行がある
    const table = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);
    const embeddingRows = await db.execute(sql`
      SELECT * FROM ${sql.identifier(table)}
      WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${memoryId}
    `);
    expect(embeddingRows.rows).toHaveLength(1);
  });

  it("同じ externalId の Observation を二重に observe() しても Memory が重複して作られない（本物の Postgres）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const runtime = await buildRuntime();
    const ctx: Ctx = { tenantId: "tenant-roundtrip-idem" };

    await runtime.observe(ctx, {
      kind: "utterance",
      text: "冪等性チェック用の発話",
      externalId: "ext-roundtrip-1",
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "冪等性チェック用の発話（無視されるべき）",
      externalId: "ext-roundtrip-1",
    });
    expect(second.extraction).toBe("skipped");

    const memoryCount = await db.execute(sql`
      SELECT count(*)::int AS count FROM memories WHERE tenant_id = ${ctx.tenantId}
    `);
    expect((memoryCount.rows[0] as unknown as { count: number }).count).toBe(1);

    const observationCount = await db.execute(sql`
      SELECT count(*)::int AS count FROM observations WHERE tenant_id = ${ctx.tenantId}
    `);
    expect((observationCount.rows[0] as unknown as { count: number }).count).toBe(1);
  });

  it("memory_usage の使用報告は抽出器を通らず、reinforce が実 DB に反映される", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const runtime = await buildRuntime();
    const ctx: Ctx = { tenantId: "tenant-roundtrip-usage" };

    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "使用報告の対象" });
    const memoryId = observeResult.memoryIds[0]!;

    const memoryStore = new PostgresMemoryStore(db);
    const before = await memoryStore.get(ctx, memoryId);
    expect(before?.lastReinforcedAt).toBeNull();

    // `recall_usages.recall_id` は `recalls(id)` への外部キー。recall() 自体は
    // roadmap.md 段階4の範囲であり、ここでは使用報告を試すための行を直接用意する。
    const recallRow = await db.execute(sql`
      INSERT INTO recalls (id, tenant_id, query, usage, index_band)
      VALUES (gen_random_uuid(), ${ctx.tenantId}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
      RETURNING id
    `);
    const recallId = (recallRow.rows[0] as unknown as { id: string }).id;

    await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memoryId],
    });

    const after = await memoryStore.get(ctx, memoryId);
    expect(after?.lastReinforcedAt).not.toBeNull();
  });
});

afterAll(async () => {
  await closeTestClient();
});

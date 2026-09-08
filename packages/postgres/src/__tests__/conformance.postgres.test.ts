import { afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import {
  describeEventStoreConformance,
  describeMemoryStoreConformance,
  describeOutboxStoreConformance,
  describeTenantSettingsStoreConformance,
  describeVectorStoreConformance,
} from "@mnemora/testkit";
import { buildNewMemoryFixture, buildProvenanceFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { rowToOutboxJob, type OutboxJobRow } from "../mapping.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `packages/testkit` の適合テストを、本物の Postgres 実装に対して実行する
 * （roadmap.md 段階2の完了条件: 「testkit の適合テストが postgres 実装に対してすべて通る」）。
 *
 * 擬似物（in-memory）ではなく実際に繋がっていることは、`docs/decisions/0001-orm-drizzle.md`
 * が要求する外部キー・一意制約・partial index が実際に効くかどうかで検証される
 * （in-memory 実装は制約を一切模していないため、この種の不整合はここでしか見つからない）。
 */

describeMemoryStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresMemoryStore(db);
  },
  prepareRecallId: async (ctx: Ctx) => {
    const { db } = await getTestClient();
    const result = await db.execute(sql`
      INSERT INTO recalls (id, tenant_id, query, usage, index_band)
      VALUES (gen_random_uuid(), ${ctx.tenantId}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
      RETURNING id
    `);
    return (result.rows[0] as unknown as { id: string }).id;
  },
  // ⚠ 生 SQL ではなく PostgresEventStore.list を通す。
  // このフックは「イベントが積まれていないこと」を測る道具であり、**形式不正な id を
  // 渡される検査でも使われる**（updateStatusWithEvent の歯）。生 SQL のままだと
  // memory_id が uuid 型なのでドライバのパースエラーになり、**測りたい差ではなく
  // フィクスチャ側の都合で赤くなる**（実際に CI でそうなった）。adapter が読むのと
  // 同じ経路で読めば、その経路のガード（isUuidLike）がそのまま効く。
  listEventsForMemory: async (ctx: Ctx, memoryId: string) => {
    const { db } = await getTestClient();
    return new PostgresEventStore(db).list(ctx, { memoryId });
  },
});

describeEventStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresEventStore(db);
  },
  prepareMemoryId: async (ctx: Ctx) => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId }));
    return memory.id;
  },
});

describeVectorStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresVectorStore(db);
  },
  prepareMemoryId: async (ctx: Ctx, attrs) => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        ...(attrs?.status !== undefined ? { status: attrs.status } : {}),
        ...(attrs?.subjectId !== undefined ? { subjectId: attrs.subjectId } : {}),
        ...(attrs?.decayFloorAt !== undefined ? { decayFloorAt: attrs.decayFloorAt } : {}),
        ...(attrs?.provenanceKind !== undefined
          ? { provenance: buildProvenanceFixture(attrs.provenanceKind) }
          : {}),
        ...(attrs?.occurredAt !== undefined ? { occurredAt: attrs.occurredAt } : {}),
        ...(attrs?.recordedAt !== undefined ? { recordedAt: attrs.recordedAt } : {}),
      }),
    );
    return memory.id;
  },
  // ADR 0065: `PostgresVectorStore` は `memory_embeddings_<space>` が
  // `registerEmbeddingSpace` で事前に作られている前提で動く（`PostgresVectorStore` の
  // クラス doc）。既定の space（`TEST_EMBEDDING_SPACE`）は `getTestClient()` が登録済みだが、
  // 「space 分離」の歯が使う2つ目の space はここで登録する。`registerEmbeddingSpace` は
  // `CREATE TABLE IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS`（advisory lock で排他）なので
  // 何度呼んでもべき等——毎 `it()` で呼んでも問題ない。テーブルの行は
  // `resetTestDatabase()` の `TRUNCATE ... CASCADE` が `memories` への外部キー経由で
  // 巻き込んで空にする（`DOMAIN_TABLES` に明示していなくても、CASCADE は FK 参照元を
  // 自動的に含める）。
  prepareEmbeddingSpace: async (space) => {
    const { pool } = await getTestClient();
    await registerEmbeddingSpace(pool, space);
  },
});

describeOutboxStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresOutboxStore(db);
  },
  seedJob: async (ctx: Ctx, input) => {
    const { db } = await getTestClient();
    const result = await db.execute(sql`
      INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
      VALUES (
        gen_random_uuid(),
        ${ctx.tenantId},
        ${input.kind},
        ${JSON.stringify(input.payload ?? {})}::jsonb,
        ${input.availableAt ?? new Date()},
        0,
        now()
      )
      RETURNING *
    `);
    return rowToOutboxJob(result.rows[0] as unknown as OutboxJobRow);
  },
});

describeTenantSettingsStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresTenantSettingsStore(db);
  },
  setDefaultHalfLifeHours: async (ctx: Ctx, hours: number) => {
    const { db } = await getTestClient();
    await db.execute(sql`
      INSERT INTO tenant_settings (tenant_id, default_half_life_hours, taxonomy_mode, created_at, updated_at)
      VALUES (${ctx.tenantId}, ${hours}, 'open', now(), now())
      ON CONFLICT (tenant_id) DO UPDATE SET default_half_life_hours = EXCLUDED.default_half_life_hours
    `);
  },
});

afterAll(async () => {
  await closeTestClient();
});

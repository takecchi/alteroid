import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryStatus } from "@mnemora/core";
import { defaultDecayStrategy } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 誤り1の修正の検査（マネージャー指摘）:
 *
 * `docs/memory-model.md` §10 の原案は `idx_memories_recall_gate` の述語を
 * `WHERE status = 'active'` としていたが、これでは `contested` な Memory が段1の
 * 候補集合にそもそも入らず、「争われている主張を、争われていない顔で出さない」
 * （mandatory companion retrieval、docs/memory-model.md §5・docs/recall.md §8）が
 * 実装として成立しない。本PRで述語を `WHERE status IN ('active', 'contested')` に
 * 修正した（`migrations/0001_init.sql`）。
 *
 * このテストは二つを検査する:
 * 1. 修正後の述語でも `idx_memories_recall_gate` が実際に `EXPLAIN` 上で使われること。
 * 2. `contested` な Memory が実際にこのクエリの結果集合に現れること（索引の話とデータの話、
 *    両方を検査しないと「索引はあるが述語を書き間違えて何も拾えていない」を見逃す）。
 */

const TENANT = "recall-gate-tenant";
// btree の partial index をシーケンシャルスキャンより優先させるため、行数を多めに用意する。
const ROW_COUNT = 4000;

async function insertManyMemories(
  store: PostgresMemoryStore,
  ctx: Ctx,
  statuses: MemoryStatus[],
  pool: Pool,
) {
  for (let i = 0; i < ROW_COUNT; i += 1) {
    const status = statuses[i % statuses.length]!;
    await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId, status }));
  }
  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引を選んでしまう
  // （実測: ANALYZE 無しでは idx_memories_provenance_kind が選ばれることがあった）。
  await pool.query("ANALYZE memories");
}

describe("idx_memories_recall_gate (誤り1の修正)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("修正後の述語 (status IN ('active','contested')) でも索引が使われ、contested な Memory も候補に含まれる", async () => {
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await insertManyMemories(
      store,
      ctx,
      ["active", "contested", "superseded", "archived", "forgotten"],
      pool,
    );

    const explainResult = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       SELECT id, status FROM memories
       WHERE tenant_id = $1 AND status = ANY($2::text[]) AND decay_floor_at > now() - interval '1000 days'
       ORDER BY decay_floor_at
       LIMIT 50`,
      [TENANT, ["active", "contested"]],
    );
    const plan = explainResult.rows
      .map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"])
      .join("\n");
    // ⚠ この2行はプランナの選択を assert している——版・統計・データ規模に依存する。
    //  測った版: **分からない**（この歯を足した PR #3 の本文に、この assert を通した CI run 番号も
    //    Postgres の版も記載が無い。PR #3 追記の PostgreSQL 18.6 + pgvector 0.8.6 での変異検査
    //    ——述語を `status = 'active'` に戻すと赤くなる——は作業環境での実測であり、CI での実測ではない）。
    //    言えるのは「CI（`pgvector/pgvector:pg17`）では通っている」までである（配線から読める事実）。
    //  赤くなったら疑うもの: (1) 自分の変更 (2) 実行中の Postgres のメジャー版
    //    (3) ANALYZE / 統計情報（上の seed のコメントに実測が在る: ANALYZE 無しでは
    //    `idx_memories_provenance_kind` が選ばれることがあった）。⟹ まず `origin/main` で対照を取ること。
    //  見直す合図: **当たる ADR は無い**（この索引は docs/memory-model.md §10 と docs/recall.md §5 に
    //    直接書かれており、ADR を経ていない）。⟹ 崩れたら、まず見直す先を決める必要が在る。
    expect(plan).toContain("idx_memories_recall_gate");
    expect(plan).not.toMatch(/Seq Scan on memories/);

    const dataResult = await pool.query(
      `SELECT status FROM memories
       WHERE tenant_id = $1 AND status = ANY($2::text[])`,
      [TENANT, ["active", "contested"]],
    );
    const statusesReturned = new Set(dataResult.rows.map((row: { status: string }) => row.status));
    expect(statusesReturned.has("active")).toBe(true);
    expect(statusesReturned.has("contested")).toBe(true);
    expect(statusesReturned.has("superseded")).toBe(false);
    expect(statusesReturned.has("archived")).toBe(false);
    expect(statusesReturned.has("forgotten")).toBe(false);
  }, 60_000);

  it("decay_floor_at は Phase 1 では読み取りフィルタに使わない（roadmap.md、誤り3の整理）が、索引の3列目としては持つ", async () => {
    // Phase 1 は decay_floor_at を書き込むだけで、段1の WHERE には使わない
    // （roadmap.md「Phase 2 で WHERE decay_floor_at > now() を使い始めるだけ」）。
    // ここでは「書き込み時に decay_floor_at が計算されている」ことと、索引が
    // (tenant_id, status, decay_floor_at) の3列構成であることをスキーマ側で確認する。
    const { pool } = await getTestClient();
    const indexDef = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_memories_recall_gate'`,
    );
    expect(indexDef.rows[0]?.indexdef).toContain("decay_floor_at");
    expect(indexDef.rows[0]?.indexdef).toContain("tenant_id");
    expect(indexDef.rows[0]?.indexdef).toContain("status");

    const ctx: Ctx = { tenantId: TENANT };
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: TENANT }));
    const expected = defaultDecayStrategy.floorAt({
      recordedAt: memory.recordedAt,
      lastReinforcedAt: null,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });
    expect(memory.decayFloorAt.getTime()).toBe(expected.getTime());
  });
});

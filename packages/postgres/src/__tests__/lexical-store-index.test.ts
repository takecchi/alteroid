import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { buildLexicalSearchSelect } from "../lexical-store.js";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 「対照」テストが `idx_memories_lexical` を作り直すための DDL。**マイグレーションファイル
 * から切り出して読む**——ここに DDL を書き写すと `migrations/0008_*.sql` を直したときに
 * この復元だけ古い定義のまま静かにずれる（`outbox-claim-lease-index.test.ts` の
 * `MIGRATION_0002_SQL` と同じ理由）。
 *
 * migration 0008 は `CREATE FUNCTION`（非冪等。再実行すると `already exists` で失敗する）と
 * `CREATE INDEX` の2文を持つ——ファイル全体を流し直す（`MIGRATION_0002_SQL` の作法）と
 * 関数が既に存在してエラーになる（関数は「対照」テストでも落としていない）ため、
 * ファイル末尾の `CREATE INDEX ...` 文だけを切り出す。
 */
const MIGRATION_0008_SQL = readFileSync(
  join(DEFAULT_MIGRATIONS_DIR, "0008_memories_lexical_index.sql"),
  "utf8",
);
const CREATE_INDEX_SQL = MIGRATION_0008_SQL.slice(
  MIGRATION_0008_SQL.indexOf("CREATE INDEX idx_memories_lexical"),
);

/**
 * `idx_memories_lexical`（`migrations/0008_memories_lexical_index.sql`）が
 * `PostgresLexicalStore.search`（`buildLexicalSearchSelect`、`../lexical-store.js`）の
 * 述語で実際に使われることの実測（ADR 0084、Issue #106）。
 *
 * **本体と同じ `SELECT` を `EXPLAIN` する**——テスト側に述語を書き写さない
 * （`memories-requeue-embed-index.test.ts` の `explainTargetSelect` と同じ理由・同じ形。
 * `buildLexicalSearchSelect` の doc コメント参照）。
 *
 * `filter.status` に `['active', 'contested']` を明示して渡す——`idx_memories_lexical` は
 * `WHERE status IN ('active', 'contested')` の部分索引であり、クエリ側がこの2値だけに
 * 絞ってはじめて索引の述語を含意できる（`filter.status` を渡さない/この2値以外を含む
 * 場合は、この部分索引だけでは正しさは変わらないが速さの保証は無い——
 * `interfaces/lexical-store.ts` の doc が言う「各フィールドを adapter が実際に適用する」
 * とは独立の話である）。
 *
 * ⚠ **この歯はプランナの選択を assert している**——版・統計・データ規模に依存する
 * （`recall-gate-index.test.ts` / `memories-requeue-embed-index.test.ts` と同じ留保）。
 * 赤くなったら疑うもの: (1) 自分の変更 (2) 実行中の Postgres のメジャー版
 * (3) ANALYZE / 統計情報。⟹ まず `origin/main` で対照を取ること。
 */

const TENANT = "lexical-index-tenant";
// GIN の部分索引を Seq Scan より優先させるため、行数を多めに用意する
// （recall-gate-index.test.ts / memories-requeue-embed-index.test.ts と同じ勘所）。
const ROW_COUNT = 20_000;

/**
 * `memories` に大量行を投入する。定常状態に近づけるため、大半を `active`、少量を
 * `contested`（部分索引の対象に残るが稀）、残りを索引対象外の状態に散らす
 * （`memories-requeue-embed-index.test.ts` の `seedManyMemories` と同じ考え方）。
 *
 * クエリ語「obsidian shards」を含む行は 50 行に1行（2%）だけにする——語彙一致の選択性が
 * 高い状態（ほとんどの行は一致しない）を再現するため。含まない行は語彙が全く重ならない
 * 日本語の埋め文で埋める（正規化の対象にも実際になる、この歯が測りたい経路そのもの）。
 */
async function seedManyMemories(pool: Pool, tenant: string, rowCount: number): Promise<void> {
  await pool.query(
    `
    INSERT INTO memories (
      id, tenant_id, subject_id, content, content_hash, digest, digest_source,
      provenance_kind, provenance, status, tags, occurred_at, recorded_at,
      last_reinforced_at, strength, half_life_hours, decay_floor_at,
      embedding_status, created_at, updated_at
    )
    SELECT
      gen_random_uuid(),
      $1,
      NULL,
      CASE WHEN i % 50 = 0 THEN 'obsidian shards glimmer in seed content ' || i
           ELSE '関係の無い埋め文その' || i END,
      'seed-content-hash-' || i,
      'seed digest ' || i,
      'llm',
      'imported',
      '{"kind":"imported","batchId":"fixture-batch"}'::jsonb,
      CASE
        WHEN i % 100 = 0 THEN 'contested'
        WHEN i % 100 = 1 THEN 'archived'
        ELSE 'active'
      END,
      '{}',
      NULL,
      now() - (i || ' seconds')::interval,
      NULL,
      1.0,
      720,
      now() + interval '30 days',
      'ready',
      now() - (i || ' seconds')::interval,
      now() - (i || ' seconds')::interval
    FROM generate_series(1, $2) AS i
    `,
    [tenant, rowCount],
  );
  // 統計情報が無い/古いと、プランナが誤った行数見積もりで Seq Scan や無関係な索引を選ぶ
  // （recall-gate-index.test.ts / memories-requeue-embed-index.test.ts と同じ勘所）。
  await pool.query("ANALYZE memories");
}

function planText(rows: { "QUERY PLAN": string }[]): string {
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

async function explainSearch(): Promise<string> {
  const { db } = await getTestClient();
  const ctx: Ctx = { tenantId: TENANT };
  const select = buildLexicalSearchSelect("obsidian shards", {
    limit: 50,
    filter: { tenantId: ctx.tenantId, status: ["active", "contested"] },
  });
  const result = await db.execute(sql`EXPLAIN (FORMAT TEXT) ${select}`);
  return planText(result.rows as unknown as { "QUERY PLAN": string }[]);
}

describe("idx_memories_lexical（ADR 0084、Issue #106）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("PostgresLexicalStore.search が実際に打つ SELECT で idx_memories_lexical が使われ、Seq Scan on memories は選ばれない", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    const plan = await explainSearch();
    console.log(`=== EXPLAIN（idx_memories_lexical、行数 ${ROW_COUNT}）===\n${plan}`);

    expect(plan).toContain("idx_memories_lexical");
    expect(plan).not.toMatch(/Seq Scan on memories/);
  }, 60_000);

  it("参考: idx_memories_lexical を落とすと Seq Scan on memories になる（対照。プランナが本当にこの索引を選んでいたことの裏取り）", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    await pool.query("DROP INDEX idx_memories_lexical");
    try {
      const plan = await explainSearch();
      console.log(`=== EXPLAIN（idx_memories_lexical 無し、対照）===\n${plan}`);
      expect(plan).toMatch(/Seq Scan on memories/);
    } finally {
      // マイグレーションファイルから切り出した DDL で元に戻す（CREATE_INDEX_SQL の doc
      // 参照）——DROP したままだと同じプロセス内で後から走る他のテストまで索引の無い
      // 状態を引きずる（`memories-requeue-embed-index.test.ts` と同じ理由）。
      await pool.query(CREATE_INDEX_SQL);
    }
  }, 60_000);
});

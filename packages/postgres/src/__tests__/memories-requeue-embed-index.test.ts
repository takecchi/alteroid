import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import { buildRequeueEmbedTargetSelect } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 「前」の測定のために落とした索引を作り直すための DDL。**マイグレーションファイルから
 * そのまま読む**——ここに DDL を書き写すと、migrations/0007_memories_requeue_embed_index.sql
 * を後から直したときに、この復元だけが古い定義のまま静かにずれる（
 * outbox-claim-lease-index.test.ts の MIGRATION_0002_SQL と同じ理由）。
 */
const MIGRATION_0007_SQL = readFileSync(
  join(DEFAULT_MIGRATIONS_DIR, "0007_memories_requeue_embed_index.sql"),
  "utf8",
);

/**
 * ADR 0079 の実測。
 *
 * `PostgresMemoryStore.requeueEmbedJobs`（`../memory-store.js`）が対象を選ぶ CTE の
 * 中身は `buildRequeueEmbedTargetSelect` が組み立てる。**この検査はその関数の返り値を
 * そのまま `EXPLAIN` する**——テスト側に述語を書き写さない（`explainTargetSelect` の
 * doc コメント参照）。
 *
 * `migrations/0007_memories_requeue_embed_index.sql` はこの述語のための部分索引
 * `idx_memories_requeue_embed`（`(tenant_id, updated_at, id)`、
 * `WHERE status IN ('active', 'contested') AND embedding_status <> 'ready'`）を足した。
 *
 * このテストは3本ある:
 * 1. **前** = 索引が無い世界。`ORDER BY updated_at, id LIMIT n` を索引が供給できず
 *    `Sort` が挟まる（＝ `LIMIT` の早期打ち切りが効かない）ことを確認する。
 * 2. **後** = 索引が在る世界。索引が実際に使われ、**`Sort` が消える**ことを確認する。
 *    ⟹ **本体の述語を変えるとこの検査が直接それを測る**（同じ SQL を EXPLAIN している）。
 * 3. ⭐ **当初の見立てが崩れた記録。**本 PR は当初、本体の WHERE に
 *    `AND embedding_status <> 'ready'` を冗長を承知で書いていた。CI の EXPLAIN で
 *    **2重に崩れた**——書かなくても索引は選ばれ、書くとむしろ Sort が挟まって遅くなる。
 *    その差を出力そのもので残す（詳細はその `it()` の doc コメント）。
 *
 * すべて `console.log` で全文を出力する——「索引が使われる/使われない」を出力そのもので
 * 示す必要がある（「使われるはず」と書かない）。CI のログから PR 本文へ貼るための意図的な
 * 出力であり、削らないこと。
 *
 * `EXPLAIN`（`ANALYZE` を付けない）はプランを組み立てるだけで実際にはクエリを実行しない
 * ——`FOR UPDATE SKIP LOCKED` を含む `SELECT` を対象にしても安全にプランだけ取れる。
 */

const TENANT = "memories-requeue-embed-tenant";
// btree の partial index をシーケンシャルスキャンより優先させるため、行数を多めに用意する
// （outbox-claim-lease-index.test.ts / recall-gate-index.test.ts と同じ勘所）。
const ROW_COUNT = 20_000;

/**
 * `memories` に、本物の定常状態に近い分布のデータを大量に用意する。
 *
 * **なぜこの分布が「現実的」と言えるか（1行の根拠。数字合わせのための調整はしない）**:
 * 正常に動いている系では大半の Memory が `ready` である——`embedding_status` の既定は
 * `pending` で、`tick()` の `processEmbedJob` が処理して `ready` に進める。ある瞬間の
 * 断面を見れば、**大半の行は既に `ready` に達しており、まだ埋め込みが済んでいない行は
 * 少数派**という定常状態になる（`migrations/0007_*.sql` の「索引の母数について」節と
 * 同じ想定）。ここでは 95% を `ready`、残り5%を `failed`/`pending` に半々で散らす。
 * `status` も大半を `active` にする（`memories` の定常状態は係争も無いのが通常）。
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
      'seed content ' || i,
      'seed-content-hash-' || i,
      'seed digest ' || i,
      'llm',
      'imported',
      '{"kind":"imported","batchId":"fixture-batch"}'::jsonb,
      -- status: 大半を 'active' にする。1% を 'contested'（部分索引の対象に含まれる）、
      -- 1% を 'archived'（部分索引の対象から外れる。索引の選択性を現実的にするため
      -- 対象外の status も少量混ぜる）にする。
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
      -- embedding_status: 95% を 'ready'、5% を 'failed'/'pending' に半々で散らす
      -- （上のdocコメント参照）。
      CASE
        WHEN i % 20 != 0 THEN 'ready'
        WHEN i % 40 = 0 THEN 'failed'
        ELSE 'pending'
      END,
      now() - (i || ' seconds')::interval,
      now() - (i || ' seconds')::interval
    FROM generate_series(1, $2) AS i
    `,
    [tenant, rowCount],
  );
  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引や Seq Scan を選ぶ
  // （recall-gate-index.test.ts / outbox-claim-lease-index.test.ts と同じ勘所）。
  await pool.query("ANALYZE memories");
}

function planText(rows: { "QUERY PLAN": string }[]): string {
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

const CTX: Ctx = { tenantId: TENANT };
const OPTS = { statuses: ["failed", "pending"] as const, limit: 50 };

/**
 * 🔴 **本体が実際に打つ `SELECT` をそのまま `EXPLAIN` する。**
 *
 * `buildRequeueEmbedTargetSelect`（`../memory-store.js`）は
 * `PostgresMemoryStore.requeueEmbedJobs` が CTE の中身として使っている、まさにその
 * `SQL` を返す。**ここで述語を書き写すと、本体を直したときにこの歯だけが古い述語を
 * 測り続ける**——「後」の assert が緑のまま、実際には索引が使われなくなる。
 * ⟹ **本体の述語を変えると、この歯がその変更を直接測る。**それがこの共有の目的である。
 */
async function explainTargetSelect(): Promise<string> {
  const { db } = await getTestClient();
  const target = buildRequeueEmbedTargetSelect(CTX, { ...OPTS, statuses: [...OPTS.statuses] });
  if (target === null) {
    throw new Error("buildRequeueEmbedTargetSelect が null を返した（memoryIds を渡していない）");
  }
  const result = await db.execute(sql`EXPLAIN (FORMAT TEXT) ${target}`);
  return planText(result.rows as unknown as { "QUERY PLAN": string }[]);
}

describe("memories の requeueEmbedJobs 索引（ADR 0079）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("前: idx_memories_requeue_embed が無い世界では Sort が挟まる（LIMIT の早期打ち切りが効かない）", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    // 「前」= 本PR以前の姿を再現する。`idx_memories_requeue_embed` は本PRが足した
    // 索引であり「前」の世界には存在しない——migrate 済みの DB からこのテストの間だけ
    // 一時的に落とす。**`resetTestDatabase()` はテーブルの中身を TRUNCATE するだけで、
    // マイグレーション（索引を含むスキーマ）は再実行しない**（`getTestClient()` が
    // プロセス内で一度だけ migrate する設計、`test-db.ts` 参照）——DROP したままだと
    // 直後の「後」テストや、同じプロセス内で後から走る他のテストまで索引の無い状態を
    // 引きずってしまう。**必ず `finally` で元の定義
    // （`migrations/0007_memories_requeue_embed_index.sql` と同一の DDL）を作り直す。**
    await pool.query("DROP INDEX idx_memories_requeue_embed");
    try {
      const plan = await explainTargetSelect();
      console.log(`=== EXPLAIN（前: idx_memories_requeue_embed 無し）===\n${plan}`);

      // ⚠ **`Seq Scan on memories` を assert しない。**「前」の世界でプランナが
      // Seq Scan を選ぶか、既存の別の索引（`idx_memories_recall_gate` など）を
      // 選ぶかは統計次第であり、**どちらでもこの PR の主張は変わらない。**
      // 測りたいのは「`ORDER BY updated_at, id LIMIT n` を索引が供給できていない」
      // ——すなわち `Sort` が挟まっていて `LIMIT` の早期打ち切りが効かないこと
      // そのものである。実際にどちらが選ばれたかは上の `console.log` が示す。
      expect(plan).toContain("Sort");
    } finally {
      // マイグレーションファイルそのものを流し直して戻す（MIGRATION_0007_SQL の doc 参照）。
      await pool.query(MIGRATION_0007_SQL);
    }
  }, 60_000);

  it("後: idx_memories_requeue_embed が実際に使われ、updated_at, id の全体ソートを索引が肩代わりする", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    const plan = await explainTargetSelect();
    console.log(`=== EXPLAIN（後: idx_memories_requeue_embed 在り）===\n${plan}`);

    expect(plan).toContain("idx_memories_requeue_embed");
    // 「索引が使われている」だけでは足りない——測りたいのは「`updated_at, id` の
    // 全体ソートを索引が肩代わりしている」ことそのもの（outbox-claim-lease-index.test.ts
    // と同じ勘所）。これが無いと `ORDER BY ... LIMIT` の早期打ち切りが効かない。
    //
    // ⚠ **`"Sort Key: memories.updated_at"` と書かないこと。**PostgreSQL の EXPLAIN は
    // 単一テーブルの `Sort Key` に表名を前置しない（実測: 出るのは
    // `Sort Key: updated_at, id`）。表名つきで書くと**この assert は常に成立し、
    // Sort が挟まっていても緑になる**——一度そうなっていた（ADR 0079「測ったこと」）。
    expect(plan).not.toContain("Sort Key");
  }, 60_000);

  /**
   * ⭐ **当初の見立てが崩れた記録。**
   *
   * 本 PR は当初、本体の `WHERE` に `AND embedding_status <> 'ready'` を
   * **冗長を承知で書いていた**——部分索引の述語をクエリ側へ写さないと含意が成立せず
   * 索引が選ばれない、と考えたためである（ADR 0032 で一度踏んだ穴と同じ形だと読んだ）。
   *
   * **CI の EXPLAIN でその見立ては2重に崩れた:**
   * 1. 書かなくても索引は選ばれる。プランナは `= ANY($n)` の**実引数を定数として**
   *    見るので（node-postgres の unnamed statement は custom plan になる）、
   *    `embedding_status <> 'ready'` は含意される。
   * 2. **書くと逆に遅くなる。**その条件片が Recheck Cond に回って Bitmap Heap Scan が
   *    選ばれ、`ORDER BY` のために Sort が挟まる。
   *
   * この検査はその差を**出力そのもので**残す。⚠ **「冗長だが無害」ではなかった**
   * ——[ADR 0078](../../../../docs/decisions/0078-strength-value-range.md) が
   * `Number.isFinite` で踏んだのと同じく、**歯が当たらない冗長なコードは消すのが
   * このリポジトリの型である。**ここではさらに、消したほうが速いことまで測れた。
   */
  it("⭐ embedding_status <> 'ready' を書き足すと、索引は使われるが Sort が挟まって遅くなる（当初の見立ての反証）", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    const explainResult = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       SELECT id FROM memories
       WHERE tenant_id = $1
         AND status IN ('active', 'contested')
         AND embedding_status <> 'ready'
         AND embedding_status = ANY($2::text[])
       ORDER BY updated_at ASC, id ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [TENANT, ["failed", "pending"], 50],
    );
    const plan = planText(explainResult.rows as { "QUERY PLAN": string }[]);
    console.log(`=== EXPLAIN（<> 'ready' を書き足した述語。本体はこれを書かない）===\n${plan}`);

    // 索引そのものは使われる（見立て1の反証）。
    expect(plan).toContain("idx_memories_requeue_embed");
    // しかし Sort が挟まる（見立て2。本体がこの条件片を書かない理由）。
    expect(plan).toContain("Sort Key");
  }, 60_000);
});

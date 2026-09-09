import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `memories.contested_with_id`（0001_init.sql）は memories(id) への自己参照 FK だが、
 * この列を先頭に置いた索引が一本も無かった（`idx_memories_contested` は `status` の
 * 索引であって `contested_with_id` の索引ではない——decoy）。親側の DELETE のたびに、
 * Postgres の参照整合性トリガーはおおむね次の形のクエリを発行して
 * 「この行を contested_with_id として指している行が無いか」を確かめる:
 *
 *   SELECT 1 FROM ONLY "public"."memories" x
 *     WHERE $1 OPERATOR(pg_catalog.=) "contested_with_id" FOR KEY SHARE OF x
 *
 * この WHERE には tenant_id が一切現れない。索引が無いと、この問い合わせのたびに
 * memories 全体の Seq Scan が走る。本ファイルはこれを実測し、
 * `migrations/0004_contested_with_index.sql` を足した後に Index Scan へ変わることを
 * `EXPLAIN` で検査する。
 *
 * **このファイルが検査しないこと（マネージャー指摘、意図的な不採用）**:
 * - 「索引 idx_memories_contested_with が存在する」というスキーマの写し assert は
 *   書かない。索引の存在そのものは何も保証しない——存在してもプランナに選ばれなければ
 *   DELETE は今までどおり遅いままであり、「存在する」だけを assert する歯は
 *   この不具合を再発させても落ちない。
 * - DELETE の所要時間（ミリ秒）に対する assert も書かない。CI ランナーの混雑・
 *   ウォームアップ・キャッシュ状態で揺れ、flaky の温床になる
 *   （outbox-claim-lease-index.test.ts / scale-bench.ts の方針と同じ）。
 * - 代わりに、プランナが**実際に選んだ実行計画のノード種別**（Seq Scan か Index Scan か）
 *   を `EXPLAIN` のテキストから assert する。これは時間に依存せず、かつ
 *   「索引はあるが述語や列順を間違えてプランナに選ばれていない」を実際に検出できる
 *   （このリポジトリの `idx_outbox_claimable` 初回実測がまさにこの失敗モードだった、
 *   outbox-claim-lease-index.test.ts 冒頭コメント参照）。
 *
 * seed データの分布: 本物の contested ペアは全 Memory のうち少数派である
 * （2つで1組の争いが、大量の平時の Memory の中に混じる、というのが現実の形）。
 * ここでは 100,000 行のうち 2%（2,000行 = 1,000組）だけを contested のペアにし、
 * 残りは contested_with_id が NULL の 'active' にする。行数を多くするのは、
 * btree の部分索引が Seq Scan より有利になるために十分な規模が要るため
 * （recall-gate-index.test.ts・outbox-claim-lease-index.test.ts と同じ勘所）。
 *
 * `EXPLAIN (ANALYZE, BUFFERS)` の全文を `console.log` で出力する——CI ログから
 * PR 本文へ実測値（ノード種別・timing・buffers）を貼るための意図的な出力であり、
 * 削らないこと。
 */

const TENANT = "contested-with-index-tenant";
const ROW_COUNT = 100_000;
const CONTESTED_PAIR_COUNT = 1_000; // 2,000行 = 全体の2%

/**
 * `migrations/0004_contested_with_index.sql` を後から直したときにこのファイルの
 * 「作り直し」だけが古い定義のまま静かにずれないよう、DDL はここに書き写さず
 * マイグレーションファイルからそのまま読む
 * （outbox-claim-lease-index.test.ts の `MIGRATION_0002_SQL` と同じ作法）。
 */
const MIGRATION_0004_SQL = readFileSync(
  join(DEFAULT_MIGRATIONS_DIR, "0004_contested_with_index.sql"),
  "utf8",
);

interface SeededMemories {
  /** 争われている側の id（この id への DELETE が RI チェックの対象になる）。 */
  contestedTargetId: string;
  /** contestedTargetId を contested_with_id として指している側の id。 */
  contestedReferrerId: string;
}

/**
 * memories に、本物に近い分布のデータを大量投入する（バルク SQL、1件ずつ
 * createMemory() を呼ばない——100,000件を現実的な時間で入れるため）。
 *
 * 全行の id を事前に生成し、うち先頭 `CONTESTED_PAIR_COUNT * 2` 行を2行1組で
 * 互いの contested_with_id に指定する。同一 INSERT 文の中で自己参照するが、
 * 非遅延（NOT DEFERRABLE）の FK 制約は文の実行完了後にまとめて検査されるため、
 * 同じ文の中で挿入される行同士を指し合っても違反にならない。
 */
async function seedContestedMemories(
  pool: Pool,
  tenant: string,
  rowCount: number,
  contestedPairCount: number,
): Promise<SeededMemories> {
  const ids: string[] = Array.from({ length: rowCount }, () => randomUUID());
  const contestedWithIds: (string | null)[] = new Array(rowCount).fill(null);

  for (let pair = 0; pair < contestedPairCount; pair += 1) {
    const a = pair * 2;
    const b = a + 1;
    contestedWithIds[a] = ids[b]!;
    contestedWithIds[b] = ids[a]!;
  }

  await pool.query(
    `
    INSERT INTO memories (
      id, tenant_id, content, content_hash, digest, digest_source,
      provenance_kind, provenance, status, contested_with_id,
      tags, recorded_at, strength, half_life_hours, decay_floor_at,
      embedding_status, created_at, updated_at
    )
    SELECT
      m.id,
      $2,
      'seed memory ' || m.id::text,
      md5(m.id::text),
      'seed digest ' || m.id::text,
      'llm',
      'imported',
      '{"kind":"imported"}'::jsonb,
      CASE WHEN m.contested_with_id IS NOT NULL THEN 'contested' ELSE 'active' END,
      m.contested_with_id,
      '{}'::text[],
      now(),
      1.0,
      720,
      now() + interval '30 days',
      'ready',
      now(),
      now()
    FROM unnest($1::uuid[], $3::uuid[]) AS m(id, contested_with_id)
    `,
    [ids, tenant, contestedWithIds],
  );

  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引や Seq Scan を選ぶ
  // （recall-gate-index.test.ts / outbox-claim-lease-index.test.ts と同じ勘所）。
  await pool.query("ANALYZE memories");

  return {
    contestedTargetId: ids[0]!,
    contestedReferrerId: ids[1]!,
  };
}

function planText(rows: { "QUERY PLAN": string }[]): string {
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/**
 * Postgres の参照整合性トリガーが自己参照 FK の DELETE 時に発行するのと同じ構造の
 * クエリ（マネージャー premise、このリポジトリで実測して確認済み）。`ANALYZE` を
 * 付けて実際に実行する（`FOR KEY SHARE` の行ロックは、このクエリ自身が自動コミットの
 * 単発 `pool.query` として走るため、クエリ完了と同時に解放される）。
 */
async function explainRiCheck(pool: Pool, targetId: string): Promise<string> {
  const result = await pool.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
     SELECT 1 FROM ONLY "public"."memories" x
     WHERE $1 OPERATOR(pg_catalog.=) "contested_with_id" FOR KEY SHARE OF x`,
    [targetId],
  );
  return planText(result.rows);
}

describe("idx_memories_contested_with（memories.contested_with_id の自己参照 FK 索引）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("前: idx_memories_contested_with が無い世界(本PR以前)では、RI チェックが memories を Seq Scan する", async () => {
    const { pool } = await getTestClient();
    const seeded = await seedContestedMemories(pool, TENANT, ROW_COUNT, CONTESTED_PAIR_COUNT);

    // 「前」= 本PR以前の姿を再現する。`idx_memories_contested_with` は本PRが足した索引
    // であり「前」の世界には存在しない——migrate 済みの DB からこのテストの間だけ
    // 一時的に落とす。`resetTestDatabase()` はテーブルの中身を TRUNCATE するだけで
    // スキーマ（索引を含む）は再作成しないため、**必ず `finally` で元の定義
    // （`migrations/0004_contested_with_index.sql` と同一の DDL）を作り直す**
    // ——戻し忘れると「後」のテストや、同じプロセス内で後から走る他のテストファイルまで
    // 索引の無い状態を引きずる（outbox-claim-lease-index.test.ts と同じ罠）。
    await pool.query("DROP INDEX idx_memories_contested_with");
    try {
      const plan = await explainRiCheck(pool, seeded.contestedTargetId);
      console.log(
        `=== EXPLAIN（前: idx_memories_contested_with 無し・RI チェックの述語）===\n${plan}`,
      );

      expect(plan).toMatch(/Seq Scan on memories x/);
      expect(plan).not.toContain("idx_memories_contested_with");
    } finally {
      await pool.query(MIGRATION_0004_SQL);
    }
  }, 60_000);

  it("後: idx_memories_contested_with がある世界では、RI チェックは Index Scan になり Seq Scan は使われない", async () => {
    const { pool } = await getTestClient();
    const seeded = await seedContestedMemories(pool, TENANT, ROW_COUNT, CONTESTED_PAIR_COUNT);

    const plan = await explainRiCheck(pool, seeded.contestedTargetId);
    console.log(
      `=== EXPLAIN（後: idx_memories_contested_with 有り・RI チェックの述語）===\n${plan}`,
    );

    // ⚠ この3行はプランナの選択を assert している——版・統計・データ規模に依存する。
    //  測った版: **PostgreSQL 17.11 + pgvector 0.8.6**（100,000行・ANALYZE 後、作業環境での実測。
    //    PR #69 本文に EXPLAIN が cost の値ごと逐語で貼ってある）。加えて **CI run 34204550584** で
    //    `packages/postgres` ジョブが緑になっている（CI は `pgvector/pgvector:pg17`）。
    //  赤くなったら疑うもの: (1) 自分の変更 (2) 実行中の Postgres のメジャー版
    //    (3) ANALYZE / 統計情報 (4) seed の分布——**この歯は 2% 選択性という閾値の上に立っており**、
    //    コストモデルが版で変われば真っ先に転ぶ側である。⟹ まず `origin/main` で対照を取ること。
    //  見直す合図: ADR 0062（`memories.contested_with_id` の自己参照 FK に索引を足す）。
    expect(plan).toContain("idx_memories_contested_with");
    expect(plan).toMatch(/Index Scan using idx_memories_contested_with on memories x/);
    expect(plan).not.toMatch(/Seq Scan on memories/);

    // 索引の話とデータの話、両方を検査する（recall-gate-index.test.ts と同じ理由:
    // 「索引はあるが述語を書き間違えて何も拾えていない」を見逃さないため）。
    // contestedReferrerId は contestedTargetId を contested_with_id として指している
    // 側の行——RI チェックが実際にこの1行を見つけられていることも確認する。
    const dataResult = await pool.query<{ id: string }>(
      `SELECT id FROM memories WHERE tenant_id = $1 AND contested_with_id = $2`,
      [TENANT, seeded.contestedTargetId],
    );
    expect(dataResult.rows.map((row) => row.id)).toEqual([seeded.contestedReferrerId]);
  }, 60_000);

  /**
   * `migrations/0004_contested_with_index.sql` 自身のコメントは「索引は
   * contested_with_id を先頭に置かなければ意味がない」と主張しているが、その主張を
   * 検査する歯がこれまで無かった（オーナー指摘: コメントは検査されない。「これはXだから
   * 安全」と書くなら、Xを歯にすること）。
   *
   * 上の2本（「前」「後」）の EXPLAIN assert は、**プランナが実際にこの索引を
   * 選んだこと**を証明する——が、これだけでは**なぜ選ばれたか**、つまり索引が
   * コメントの主張どおりの形（先頭列 = contested_with_id・部分述語 =
   * contested_with_id IS NOT NULL）をしているかまでは証明しない。実際、この
   * ROW_COUNT・CONTESTED_PAIR_COUNT の分布では、先頭列を誤って
   * (tenant_id, contested_with_id) にした索引や、部分述語を落とした無条件索引でも、
   * 部分述語がテーブルの2%まで絞り込むために Seq Scan よりコストが低く、プランナに
   * 選ばれてしまう（実測: cost 0.28..104.06 対 Seq Scan 5254.00）——上の EXPLAIN
   * assert は Index Scan という結果しか見ないため、この2つの壊れ方を検出できない。
   *
   * だからここでは、EXPLAIN を補う形で pg_catalog から索引の**形**そのものを読む。
   * ただし「idx_memories_contested_with が存在する」という素朴な existence assert には
   * しない——冒頭のコメント（本ファイル）が既に指摘している通り、存在そのものは
   * 「先頭列や述語を間違えていないか」を何も保証しないため。先頭列の判定は
   * `pg_indexes.indexdef`（DDL 文字列）を正規表現で突き合わせるのではなく、
   * `pg_index.indkey[0]` が指す `pg_attribute.attnum` を解決する——文字列一致は
   * 列が増えたり順序表記が変わったりしたときに書き方次第で誤検出しうるが、
   * catalog 上の列位置は表記に依存しない実体である。
   */
  it("索引の形: idx_memories_contested_with は contested_with_id を先頭列に持つ部分索引である（マイグレーションのコメントの主張を歯にする）", async () => {
    const { pool } = await getTestClient();

    const shapeResult = await pool.query<{
      leading_col: string;
      is_partial: boolean;
      pred_expr: string | null;
    }>(
      `SELECT
         a.attname AS leading_col,
         i.indpred IS NOT NULL AS is_partial,
         pg_get_expr(i.indpred, i.indrelid) AS pred_expr
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE i.indexrelid = 'idx_memories_contested_with'::regclass`,
    );

    expect(shapeResult.rows).toHaveLength(1);
    const shape = shapeResult.rows[0]!;
    // 先頭列が contested_with_id であること（M1: 先頭に tenant_id を置く壊れ方を殺す)。
    expect(shape.leading_col).toBe("contested_with_id");
    // 部分索引であり、述語が contested_with_id IS NOT NULL であること
    // （M2: 部分述語を落とす壊れ方を殺す）。
    expect(shape.is_partial).toBe(true);
    expect(shape.pred_expr).toBe("(contested_with_id IS NOT NULL)");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 「前」の測定のために落とした索引を作り直すための DDL。**マイグレーションファイルから
 * そのまま読む**——ここに DDL を書き写すと、migrations/0002_outbox_claim_lease_index.sql
 * を後から直したときに、この復元だけが古い定義のまま静かにずれる（同じ内容の写しは必ず
 * ずれる、というのは AGENTS.md が北極星の要約を置かない理由と同じ）。
 */
const MIGRATION_0002_SQL = readFileSync(
  join(DEFAULT_MIGRATIONS_DIR, "0002_outbox_claim_lease_index.sql"),
  "utf8",
);

/**
 * ADR 0032 の実測（マネージャー指摘の帰結2を検査する）。
 *
 * `PostgresOutboxStore.claimBatch`（本PR以前）の `WHERE` は `claimed_at` に一切触れない。
 * 一方 `migrations/0001_init.sql` の `idx_outbox_pending` は
 * `WHERE completed_at IS NULL AND claimed_at IS NULL` という部分索引であり、この述語は
 * 「claim のリース」が話題に上る前は「読んでそう推論した」段階でしかなかった——
 * **部分索引の述語がクエリの WHERE から論理的に含意されない限り、プランナはその索引を
 * 使えない**、という Postgres の一般的な性質から導いた推論であり、このリポジトリの
 * `EXPLAIN` で実測されたことは無かった。
 *
 * **1回目の CI 実測で、新設した `idx_outbox_claimable`（列順 `(tenant_id, kind,
 * available_at)`）も選ばれないことが判明した**（本ファイルの assert が正しく落ちた）。
 * 原因は2つ重なっていた（マネージャーの読み、CI ログの EXPLAIN から特定）:
 *
 * 1. **列順の欠陥**: `claimBatch` は `kind = ANY(ARRAY['extract','embed'])` のように
 *    複数の kind を指定する。索引が `(tenant_id, kind, available_at)` だと、`kind` を
 *    単一の値に絞らない限り、索引の並びは `available_at` の全体順序を提供できない
 *    ——プランナは必ず `Sort` を挟み、`ORDER BY ... LIMIT n` の早期打ち切りが効かない。
 *    **これは `idx_outbox_pending` から受け継いだ欠陥であり、元の索引も述語さえ揃っていれば
 *    このクエリを供給できた、という話ではなかった。** `migrations/
 *    0002_outbox_claim_lease_index.sql` で列順を `(tenant_id, available_at)` に直し、
 *    `kind` は索引に入れず残った行への `Filter` に任せる形にした。
 * 2. **seed データが非現実的だった**: 当初の seed は claim 可能な行が全体の約50%を
 *    占めており、部分索引が Seq Scan に勝てなかった。本物の outbox はワークキューであり、
 *    ある瞬間に「未処理」でいる行は少数派——大半はすぐに `completed_at`/`failed_at` が
 *    付いて捌けていく（下記 `seedManyOutboxRows` 参照）。
 *
 * このテストは:
 * 1. 「前」= 本PR以前（`idx_outbox_claimable` が存在しない世界）の（`claimed_at` に
 *    触れない）`claimBatch` の述語を、実際の `claimBatch` と同じ SQL 構造
 *    （`WITH ... FOR UPDATE SKIP LOCKED` + `UPDATE`）で `EXPLAIN` し、
 *    `idx_outbox_pending` が使われていないことを確認する（帰結2の実測）。
 *    **`idx_outbox_claimable` は本PRが足した索引であり「前」には存在しない**——
 *    この DB には既に `0002_*.sql` が適用済みなので、テストの中で明示的に
 *    `DROP INDEX idx_outbox_claimable` してから測り、**`finally` で必ず作り直す**
 *    （`resetTestDatabase()` はテーブルの中身を TRUNCATE するだけでスキーマは
 *    再作成しないため、戻し忘れると「後」のテストや後続の他テストファイルまで
 *    索引の無い状態を引きずる。詳細は下の該当 `it()` 内のコメント参照）。
 *    `EXPLAIN`（`ANALYZE` を付けない）はプランを組み立てるだけで実際にはクエリを実行
 *    しない——`UPDATE` 文を対象にしても安全にプランだけ取れる。
 * 2. 「後」= 本PR で足したリース条件（`claimed_at IS NULL OR claimed_at <= リース境界`）
 *    付きの述語を同じ構造で `EXPLAIN` し、本PRで新設した `idx_outbox_claimable`
 *    が実際に使われる**うえで**、`available_at` の全体ソートを索引が肩代わりしている
 *    こと（＝`LIMIT` が早期に打ち切れる、この PR の眼目そのもの）を assert する。
 *
 * 両方とも `console.log` で全文を出力する——「索引が使われるようになった」を出力そのもので
 * 示す必要がある（「使われるはず」と書かない）。CI のログから PR 本文へ貼るための意図的な
 * 出力であり、削らないこと。
 */

const TENANT = "outbox-claim-lease-tenant";
// btree の partial index をシーケンシャルスキャンより優先させるため、行数を多めに用意する
// （recall-gate-index.test.ts と同じ勘所。1回目の実測で claim 可能な行の絶対数が
// 少なすぎても索引が選ばれにくいことが分かったため、recall-gate-index.test.ts の
// 4000 より増やした）。
const ROW_COUNT = 20_000;

/**
 * `outbox` に、本物のワークキューに近い分布のデータを大量に用意する。
 *
 * **なぜこの分布が「現実的」と言えるか（1行の根拠。数字合わせのための調整はしない）**:
 * outbox は溜まり続けるログではなく、`tick()` が随時消化するワークキューである
 * ——`observe()`/`createMemoryWithOutbox` が積んだジョブは、通常運転では短時間で
 * `complete()`/`fail()` されて終端に達する。ある瞬間の断面を見れば、**大半の行は
 * 既に `completed_at`/`failed_at` が付いており、「まだ claim できる」行は少数派**
 * という定常状態になる。ここでは 95% を終端済み（90%完了・5%失敗）、5% を
 * 未終端（claim 可能、またはリース内/リース切れで claim 済み）にする。
 */
async function seedManyOutboxRows(pool: Pool, tenant: string, rowCount: number): Promise<void> {
  await pool.query(
    `
    INSERT INTO outbox (
      id, tenant_id, kind, payload, available_at, claimed_at, claimed_by, attempts,
      completed_at, failed_at, created_at
    )
    SELECT
      gen_random_uuid(),
      $1,
      CASE WHEN i % 2 = 0 THEN 'extract' ELSE 'embed' END,
      '{}'::jsonb,
      now() - (i || ' seconds')::interval,
      -- claimed_at: 未終端行(i % 20 = 0)の内訳をさらに3分割する。
      -- 終端済み行(completed/failed)は claim 履歴の有無がクエリの選択性に影響しない
      -- ため NULL のままにする(claimBatch は completed_at/failed_at で先に弾く)。
      CASE
        WHEN i % 20 != 0 THEN NULL
        WHEN i % 60 = 0 THEN NULL                       -- 未終端・一度も claim されていない
        WHEN i % 60 = 20 THEN now()                      -- 未終端・リース内で claim 済み
        ELSE now() - interval '2 hours'                  -- 未終端・リースが切れて claim 済み
      END,
      CASE WHEN i % 20 = 0 AND i % 60 != 0 THEN 'worker-x' ELSE NULL END,
      0,
      -- completed_at: 全体の90%(i % 20 が 2..19 の18値)を完了済みにする。
      CASE WHEN i % 20 IN (0, 1) THEN NULL ELSE now() END,
      -- failed_at: 全体の5%(i % 20 = 1)を失敗済みにする。
      CASE WHEN i % 20 = 1 THEN now() ELSE NULL END,
      now()
    FROM generate_series(1, $2) AS i
    `,
    [tenant, rowCount],
  );
  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引や Seq Scan を選ぶ
  // （recall-gate-index.test.ts の実測と同じ勘所: ANALYZE 無しでは別の索引が選ばれることがあった）。
  await pool.query("ANALYZE outbox");
}

function planText(rows: { "QUERY PLAN": string }[]): string {
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

describe("outbox claim のリース化と索引（ADR 0032）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("前: idx_outbox_claimable が無い世界(本PR以前)では、claimed_at に触れない述語でも idx_outbox_pending は使われない(帰結2の実測)", async () => {
    const { pool } = await getTestClient();
    await seedManyOutboxRows(pool, TENANT, ROW_COUNT);
    // 「前」= 本PR以前の姿を再現する。`idx_outbox_claimable` は本PRが足した索引であり
    // 「前」の世界には存在しない——migrate 済みの DB からこのテストの間だけ一時的に
    // 落とす。**`resetTestDatabase()` はテーブルの中身を TRUNCATE するだけで、
    // マイグレーション（索引を含むスキーマ）は再実行しない**（`getTestClient()` が
    // プロセス内で一度だけ migrate する設計、`test-db.ts` 参照）——DROP したままだと
    // 直後の「後」テストや、同じプロセス内で後から走る他のテストファイルまで
    // 索引の無い状態を引きずってしまう。**必ず `finally` で元の定義
    // （`migrations/0002_outbox_claim_lease_index.sql` と同一の DDL）を作り直す。**
    await pool.query("DROP INDEX idx_outbox_claimable");
    try {
      const now = new Date();
      const explainResult = await pool.query(
        `EXPLAIN (FORMAT TEXT)
         WITH claimable AS (
           SELECT id FROM outbox
           WHERE tenant_id = $1
             AND completed_at IS NULL
             AND failed_at IS NULL
             AND available_at <= $2
             AND kind = ANY($3::text[])
           ORDER BY available_at ASC
           LIMIT $4
           FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox o
         SET claimed_at = $2, claimed_by = $5, attempts = attempts + 1
         FROM claimable c
         WHERE o.id = c.id
         RETURNING o.*`,
        [TENANT, now, ["extract", "embed"], 50, "worker-explain-before"],
      );
      const plan = planText(explainResult.rows as { "QUERY PLAN": string }[]);
      console.log(
        `=== EXPLAIN（前: idx_outbox_claimable 無し・claimed_at に触れない今日の述語）===\n${plan}`,
      );

      // 帰結2の実測: idx_outbox_pending の述語（claimed_at IS NULL）はこの WHERE から
      // 含意されないため、プランナはこの索引を選べない。
      expect(plan).not.toContain("idx_outbox_pending");
    } finally {
      // マイグレーションファイルそのものを流し直して戻す（MIGRATION_0002_SQL の doc 参照）。
      await pool.query(MIGRATION_0002_SQL);
    }
  }, 60_000);

  it("後: リース条件付きの新しい述語では idx_outbox_claimable が実際に使われ、available_at の全体ソートを索引が肩代わりする", async () => {
    const { pool } = await getTestClient();
    await seedManyOutboxRows(pool, TENANT, ROW_COUNT);

    const now = new Date();
    const leaseMs = 60 * 60 * 1000; // 1時間(この検査自体の値。実運用のリース長とは無関係)。
    const leaseExpiresBefore = new Date(now.getTime() - leaseMs);

    const explainResult = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       WITH claimable AS (
         SELECT id FROM outbox
         WHERE tenant_id = $1
           AND completed_at IS NULL
           AND failed_at IS NULL
           AND available_at <= $2
           AND (claimed_at IS NULL OR claimed_at <= $3)
           AND kind = ANY($4::text[])
         ORDER BY available_at ASC
         LIMIT $5
         FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox o
       SET claimed_at = $2, claimed_by = $6, attempts = attempts + 1
       FROM claimable c
       WHERE o.id = c.id
       RETURNING o.*`,
      [TENANT, now, leaseExpiresBefore, ["extract", "embed"], 50, "worker-explain-after"],
    );
    const plan = planText(explainResult.rows as { "QUERY PLAN": string }[]);
    console.log(`=== EXPLAIN（後: リース条件付きの新しい述語）===\n${plan}`);

    // ⚠ この2行はプランナの選択を assert している——版・統計・データ規模に依存する。
    //  測った版: **番号としては分からない**。ただし PR #31 本文は「手元に PostgreSQL も Docker も
    //    無いため、これは CI の `postgres` ジョブが出力したものをそのまま貼っている。推論ではない」と
    //    明記した上で EXPLAIN を逐語掲載しており、⟹ **CI（`pgvector/pgvector:pg17`）の出力である**
    //    ことは確定している（CI run 番号は本文に無い）。
    //  赤くなったら疑うもの: (1) 自分の変更 (2) 実行中の Postgres のメジャー版
    //    (3) ANALYZE / 統計情報 (4) seed の分布（冒頭 docstring の実測: claim 可能な行が全体の約50%を
    //    占めていた当初の seed では、部分索引が Seq Scan に勝てなかった）。⟹ まず `origin/main` で対照を取ること。
    //  見直す合図: ADR 0032（outbox の claim にリースを入れる）。
    expect(plan).toContain("idx_outbox_claimable");
    // 「索引が使われている」だけでは足りない——`Seq Scan on outbox` は外側の
    // `UPDATE ... FROM claimable c` 側（本 PR の論点ではない）にも出うるため、
    // それを禁止する assert は測りたいものを測れていない(マネージャー指摘)。
    // 測りたいのは CTE 側で「available_at の全体ソートを索引が肩代わりしている」
    // ことそのもの——これが無いと ORDER BY ... LIMIT の早期打ち切りが効かない。
    expect(plan).not.toContain("Sort Key: outbox.available_at");
  }, 60_000);
});

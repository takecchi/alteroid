import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0079: `requeueEmbedJobs` の「`memories` の更新と `outbox` の INSERT は
 * 同一トランザクションである」という主張を、**実際に片方を失敗させて**検査する。
 *
 * 🔴 **この歯が無いと、その主張には歯が1本も無い。**適合スイート
 * （`packages/testkit/src/memory-store-conformance.ts`）の検査はすべて正常系であり、
 * 実装を「`UPDATE ... RETURNING` を打ってから、別の文で `INSERT`」の2文へ割る変異は
 * **正常系では同じ結果を返す**——適合スイートは1件も赤くならない
 * （ADR 0079「測ったこと」に実測を記録した）。
 *
 * ここでは `outbox` への INSERT を必ず失敗させるトリガーを一時的に作り、
 * `requeueEmbedJobs` が例外で終わったあとに **`memories.embedding_status` が
 * `failed` のまま巻き戻っている**ことを見る。2文に割った実装なら `UPDATE` だけが
 * コミットされ、Memory は `pending` に戻ったまま**運ぶジョブが無い状態**で残る
 * ——それはこの ADR が塞ごうとしている「待っても解けない `pending`」そのものであり、
 * **直すつもりの操作が同じ穴を掘る**という最悪の壊れ方になる。
 *
 * ⚠ トリガーは `finally` で必ず落とす。`resetTestDatabase()` はテーブルの中身を
 * TRUNCATE するだけでスキーマ（トリガーを含む）は作り直さないため、落とし忘れると
 * 同じプロセス内で後から走る他のテストファイルまで巻き込む
 * （`outbox-claim-lease-index.test.ts` が索引の復元で踏んでいるのと同じ勘所）。
 */

const TENANT = "requeue-atomicity-tenant";
const ctx: Ctx = { tenantId: TENANT };

const CREATE_FAILING_TRIGGER = `
  CREATE OR REPLACE FUNCTION requeue_atomicity_block_insert() RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'requeue-atomicity: outbox insert blocked on purpose';
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER requeue_atomicity_block
    BEFORE INSERT ON outbox
    FOR EACH ROW EXECUTE FUNCTION requeue_atomicity_block_insert();
`;

const DROP_FAILING_TRIGGER = `
  DROP TRIGGER IF EXISTS requeue_atomicity_block ON outbox;
  DROP FUNCTION IF EXISTS requeue_atomicity_block_insert();
`;

/**
 * `Error.cause` の連鎖を平らにして1本の文字列にする。
 *
 * **drizzle の `db.execute()` が投げる例外から元の PostgreSQL のメッセージは直接読めない**
 * ——`Failed query: <SQL>` という別の `Error` で包まれ、pg のエラーは `cause` 側に入る
 * （このリポジトリで一度実測した。`advisory-lock.ts` が生の `PoolClient` を使って
 * `err.code` を読めるのは、あちらが drizzle を経由していないからである）。
 */
function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return parts.join("\n<- caused by ->\n");
}

describe("requeueEmbedJobs の原子性（ADR 0079）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    const { pool } = await getTestClient();
    // 念のためもう一度落とす（各 it の finally で落としているが、そこへ到達しないまま
    // 落ちた場合に後続のテストファイルへ漏らさないため）。
    await pool.query(DROP_FAILING_TRIGGER);
    await closeTestClient();
  });

  it("outbox への INSERT が失敗したら、memories の更新も巻き戻る（片方だけ起きない）", async () => {
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, contentHash: "requeue-atomicity-1" }),
    );
    await store.setEmbeddingStatus(ctx, memory.id, "failed");

    await pool.query(CREATE_FAILING_TRIGGER);
    try {
      const error = await store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 10 }).then(
        () => null as unknown,
        (err: unknown) => err,
      );

      // ⚠ **`rejects.toThrow(/.../)` では捕まらない。**drizzle は失敗したクエリを
      // `Failed query: …` という別の `Error` で包み、**元の PostgreSQL の
      // エラーメッセージは `cause` の連鎖側に入る**（実測: 一度この形で赤くなった）。
      // 引数無しの `.rejects.toThrow()` に緩めると「何かが投げられた」しか測らず、
      // トリガーとは無関係な失敗（接続断・SQL の書き間違い）でも緑になる
      // ——`memory-store-conformance.ts` の `NOT_FOUND_ERROR_MESSAGE` と同じ理由。
      // ⟹ **連鎖を平らにしてから照合する。**
      expect(messageChain(error)).toMatch(/requeue-atomicity: outbox insert blocked on purpose/);

      // 🔴 ここが本題。UPDATE だけがコミットされていたら `pending` になっている。
      const after = await store.get(ctx, memory.id);
      const jobs = await pool.query(
        "SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND kind = 'embed'",
        [TENANT],
      );
      expect({
        embeddingStatus: after?.embeddingStatus,
        embedJobs: (jobs.rows[0] as { n: number }).n,
      }).toEqual({ embeddingStatus: "failed", embedJobs: 0 });
    } finally {
      await pool.query(DROP_FAILING_TRIGGER);
    }
  }, 60_000);

  it("トリガーを落とせば、同じ呼び出しが今度は成功して両方が起きる（上の歯が『常に赤い』のではないことの確認）", async () => {
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, contentHash: "requeue-atomicity-2" }),
    );
    await store.setEmbeddingStatus(ctx, memory.id, "failed");

    const result = await store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 10 });
    const after = await store.get(ctx, memory.id);
    const jobs = await pool.query(
      "SELECT payload->>'memoryId' AS memory_id FROM outbox WHERE tenant_id = $1 AND kind = 'embed'",
      [TENANT],
    );

    expect({
      requeued: result.requeued,
      requeuedIds: result.memoryIds,
      embeddingStatus: after?.embeddingStatus,
      jobTargets: (jobs.rows as { memory_id: string }[]).map((row) => row.memory_id),
    }).toEqual({
      requeued: 1,
      requeuedIds: [memory.id],
      embeddingStatus: "pending",
      jobTargets: [memory.id],
    });
  }, 60_000);
});

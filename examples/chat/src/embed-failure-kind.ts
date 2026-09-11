import type { PostgresClient } from "@mnemora/postgres";

/** `examples/chat` は `pg` を直接の依存に持たない——`PostgresClient["pool"]` を型として
 *  借りることで、`pg` への phantom dependency を作らずに `Pool` の型を得る。 */
type Pool = PostgresClient["pool"];

/**
 * `consolidation-cost` サブコマンド(Issue #136)が、`embeddingStatus: "failed"` に着地した
 * 新しい Memory について、ADR 0090 の `LocalEmbeddingProviderError.kind`
 * (`"input_too_long"` / `"unknown_input_limit"`)を読むための薄いヘルパ。
 *
 * **⚠ `Memory`/`MemoryStore` は `kind` を保存しない。**`packages/core` の
 * `processEmbedJob` は例外を捕まえて `setEmbeddingStatus(ctx, memory.id, "failed")` を
 * 書いてから再送出するだけで、`kind` は `Memory` の列に残らない
 * (`packages/core/src/runtime.ts`、確認済み)。`tick()` はその例外を
 * `outboxStore.fail(ctx, job.id, err.message)` で `outbox.last_error` に**文字列として**
 * 残す(`err.kind` は保存されない)。
 *
 * ⟹ `kind` を知る手段は、`outbox.last_error` に残った**メッセージ文字列**を、
 * `packages/local-embedding/src/pipeline.ts` が実際に投げる文言で判別する以外に無い。
 * ⛔ **`packages/core`/`packages/postgres` を変更しない**という制約の中でこれ以上の
 * 精度は買えない——このヘルパは「文字列一致による推定」であることを名乗る
 * (`"unknown"` を返す経路を持つ)。
 *
 * `packages/postgres`/`packages/core` は変更していない——`pool.query` は
 * `@mnemora/postgres` の `createPostgresClient` が返す公開の `Pool`(node-postgres）に
 * 対する素の SQL であり、他の examples/chat コード(`test-db.ts` の `TRUNCATE` 等)と
 * 同じ使い方である。
 */

/** `packages/local-embedding/src/pipeline.ts` が実際に投げる文言の部分一致で判別する。 */
const INPUT_TOO_LONG_MARKER = "上限を超えている";
const UNKNOWN_INPUT_LIMIT_MARKER = "上限を宣言していない";

/**
 * エラーメッセージ文字列から `LocalEmbeddingProviderErrorKind` を推定する(純関数)。
 * 判別できなければ `"unknown"`。
 */
export function classifyEmbedFailureMessage(
  message: string,
): "input_too_long" | "unknown_input_limit" | "unknown" {
  if (message.includes(INPUT_TOO_LONG_MARKER)) {
    return "input_too_long";
  }
  if (message.includes(UNKNOWN_INPUT_LIMIT_MARKER)) {
    return "unknown_input_limit";
  }
  return "unknown";
}

/**
 * その `memoryId` に対する `embed` ジョブのうち、最後に失敗したものの `last_error` を読み、
 * 判別した `kind` を返す。失敗したジョブが1件も無ければ `null`。
 *
 * ⚠ **DB を要求する。**`consolidation-cost.postgres.test.ts` 側で検査する
 * (`consolidation-cost.test.ts` の純関数層は `classifyEmbedFailureMessage` だけを見る)。
 */
export async function lookupLatestEmbedFailureKind(
  pool: Pool,
  tenantId: string,
  memoryId: string,
): Promise<"input_too_long" | "unknown_input_limit" | "unknown" | null> {
  const result = await pool.query<{ last_error: string | null }>(
    `SELECT last_error FROM outbox
       WHERE tenant_id = $1 AND kind = 'embed' AND payload->>'memoryId' = $2
         AND failed_at IS NOT NULL AND last_error IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    [tenantId, memoryId],
  );
  const row = result.rows[0];
  if (!row || row.last_error === null) {
    return null;
  }
  return classifyEmbedFailureMessage(row.last_error);
}

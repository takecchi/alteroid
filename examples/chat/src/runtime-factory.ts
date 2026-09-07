import type { Clock, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import {
  PostgresEventStore,
  PostgresMemoryStore,
  PostgresOutboxStore,
  PostgresTenantSettingsStore,
  PostgresVectorStore,
  closePostgresClient,
  createPostgresClient,
  registerEmbeddingSpace,
  runMigrations,
  sha256Hex,
} from "@mnemora/postgres";
import type { CreateProvidersOptions, EnvLike, ProviderMode } from "./providers.js";
import { createProviders } from "./providers.js";
import type { UsageMeter } from "./usage-meter.js";

export interface ExampleRuntimeHandle {
  runtime: Runtime;
  /** 後方互換のために残す単一ラベル（`providers.ts` の `Providers.mode` と同じ注記）。 */
  mode: ProviderMode;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** `llmMode`/`embeddingMode` のどちらかが `"openai"` のときだけ存在する。 */
  usageMeter?: UsageMeter;
  /**
   * retrieval-quality（PR 本文 (D)）が memory → observation の系譜を辿るために公開する。
   * `packages/core`/`packages/postgres` は変更していない——`MemoryStore` は元から
   * 公開 interface であり（`get`/`getObservation` は roadmap.md 段階3から存在する）、
   * これまで `createExampleRuntime` の返り値に含めていなかっただけ。
   */
  memoryStore: PostgresMemoryStore;
  close(): Promise<void>;
}

/**
 * サンプルアプリの `Runtime` を組み立てる（roadmap.md 段階7）。
 *
 * - `packages/postgres` に対してマイグレーションと埋め込み空間登録を行う。
 *   `runMigrations`（ADR 0017）・`registerEmbeddingSpace`（ADR 0018）は**どちらも**
 *   advisory lock でプロセス間排他される——複数のレプリカが同時にこの関数を呼んでも安全。
 *   **「`IF NOT EXISTS` 系だから安全」ではない**（段階1の実測で、`CREATE TABLE
 *   IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` はいずれも並行では非アトミックで、
 *   複数プロセスが同時に呼ぶと決定的にどちらか一方が落ちることを確認済み。
 *   `runMigrations` は ADR 0017、`registerEmbeddingSpace` は ADR 0018 を参照）。
 *   2つの関数は別々の advisory lock キーを使う（`MIGRATION_LOCK_KEY` /
 *   `REGISTER_EMBEDDING_SPACE_LOCK_KEY`）ため、互いをブロックしない。
 * - `packages/testkit` の擬似 provider か、本物の `packages/openai` かは
 *   `createProviders`（`OPENAI_API_KEY` の有無）が決める。
 * - `clock` は省略可能（既定は `packages/core` 側の `systemClock`、`RuntimeDeps.clock` が
 *   `undefined` のときの既定動作）。既存の呼び出し（1〜3引数）はそのまま通る——
 *   `decay` を `freshness` から分離して測る `time-term` arm（`mutable-clock.ts` の
 *   `MutableClock`）だけがこの4番目の引数を渡す。**`packages/*` は変更していない**
 *   （`RuntimeDeps.clock` は元から公開 interface の省略可能な欄である）。
 */
export async function createExampleRuntime(
  databaseUrl: string,
  env: EnvLike = process.env,
  providerOptions: CreateProvidersOptions = {},
  clock?: Clock,
): Promise<ExampleRuntimeHandle> {
  const client = createPostgresClient(databaseUrl);
  await runMigrations(client.pool);

  const { llmProvider, embeddingProvider, mode, llmMode, embeddingMode, usageMeter } =
    createProviders(env, providerOptions);
  await registerEmbeddingSpace(client.pool, embeddingProvider.space);

  const memoryStore = new PostgresMemoryStore(client.db);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: new PostgresOutboxStore(client.db),
    vectorStore: new PostgresVectorStore(client.db),
    eventStore: new PostgresEventStore(client.db),
    tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
    llmProvider,
    embeddingProvider,
    hashContent: sha256Hex,
    ...(clock !== undefined ? { clock } : {}),
  });

  return {
    runtime,
    mode,
    llmMode,
    embeddingMode,
    ...(usageMeter !== undefined ? { usageMeter } : {}),
    memoryStore,
    close: () => closePostgresClient(client),
  };
}

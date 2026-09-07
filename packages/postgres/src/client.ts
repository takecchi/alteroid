import { Pool, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import {
  DEFAULT_EXTENSION_SCHEMA,
  type SchemaNamespaceOptions,
  assertSafeSchemaName,
  searchPathFor,
} from "./schema-namespace.js";

export type Db = NodePgDatabase<typeof schema>;

export interface PostgresClient {
  pool: Pool;
  db: Db;
}

/**
 * `MemoryStore` / `VectorStore` / `EventStore` を1接続で実装するための唯一の入口
 * （ADR 0001・ADR 0003: リファレンス実装は同一 DB・同一トランザクション）。
 *
 * ## `config.schema`（feat/dedicated-schema）
 *
 * **`schema` 未指定なら、`PoolConfig` に手を加えない**——`options` に一切触らないため、
 * 今日と同じ `Pool` が作られる。
 *
 * `schema` を指定すると、libpq の startup parameter `options` に
 * `-c search_path=<searchPathFor(...)>` を載せる。
 *
 * **なぜ毎接続で `SET search_path` を発行する（`connect` イベントで `SET` する）
 * 形にせず、startup parameter `options` を使うのか**: `options` は接続確立時に
 * サーバへ渡るパラメータなので、**pool が新しいコネクションを張り直しても
 * 自動的に適用される**。`connect` イベントで `SET` する形は、張り直しのたびに
 * 取りこぼしなく処理を挟む必要があり（イベント購読の順序・エラー処理が絡む）、
 * 余計な往復も要る。`pg@8.23.0` が `options` を startup parameter として実際に
 * 送ることは `node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/connection-parameters.js`
 * の `add(params, this, 'options')`（`getLibpqConnectionString`）と、
 * `node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js` の
 * `if (params.options) { data.options = params.options }`（`connect` 内、
 * 生 socket 経路の startup message 組み立て）で確認した。
 *
 * `schema` / `extensionSchema` は `SchemaNamespaceOptions` のプロパティであり、
 * pg の `PoolConfig` が知っているキーではない——**分割代入で明示的に取り除いて**から
 * 残りを `Pool` へ渡す（pg は知らないキーを無視するはずだが、その挙動に依存しない）。
 *
 * 呼び出し側が既に `config.options` を渡していた場合は、**その値の後ろに空白区切りで
 * 追記する**（上書きして黙って捨てない）。
 */
export function createPostgresClient(
  connectionString: string,
  config?: PoolConfig & SchemaNamespaceOptions,
): PostgresClient {
  const { schema: namespaceSchema, extensionSchema, ...poolConfig } = config ?? {};

  if (namespaceSchema !== undefined) {
    assertSafeSchemaName(namespaceSchema);
    const resolvedExtensionSchema = extensionSchema ?? DEFAULT_EXTENSION_SCHEMA;
    assertSafeSchemaName(resolvedExtensionSchema);
    const searchPath = searchPathFor(namespaceSchema, resolvedExtensionSchema);
    poolConfig.options = poolConfig.options
      ? `${poolConfig.options} -c search_path=${searchPath}`
      : `-c search_path=${searchPath}`;
  }

  const pool = new Pool({ connectionString, ...poolConfig });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

export async function closePostgresClient(client: PostgresClient): Promise<void> {
  await client.pool.end();
}

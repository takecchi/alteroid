#!/usr/bin/env node
import { Pool } from "pg";
import { runMigrations } from "../migrate.js";
import { formatMigrateCliUsage, parseMigrateCliOptions } from "./cli-options.js";

/**
 * CLI エントリポイント。`DATABASE_URL` を読み、保留中のマイグレーションを適用する。
 *
 * 他パッケージやルートから直接 drizzle-kit を叩かせない、という ADR 0001 の規約により、
 * マイグレーションの実行はこの1つの口からのみ行う。
 *
 * 引数・環境変数の解釈（`--schema` / `--extension-schema` / `--extension-mode` /
 * `MNEMORA_SCHEMA` / `MNEMORA_EXTENSION_SCHEMA` / `MNEMORA_EXTENSION_MODE` / 優先順位 /
 * `--help`）は `./cli-options.ts` の `parseMigrateCliOptions` に切り出してある
 * （Issue #107、`extensionMode` は ADR 0093）。このファイルは薄く保ち、解釈結果を
 * `runMigrations` の `options` にそのまま渡すだけにする——`schema` / `extensionSchema` /
 * `extensionMode` がどれも未指定なら `{ schema: undefined, extensionSchema: undefined,
 * extensionMode: undefined }` を渡すことになるが、`runMigrations` はこれを options 省略時と
 * 同じに扱うため（`../schema-namespace.ts` / `../migrate.ts` 参照）、既定の振る舞いは
 * 今日と1バイトも変わらない。
 */
async function main(): Promise<void> {
  const parsed = parseMigrateCliOptions(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    console.error(parsed.error.message);
    process.exitCode = 1;
    return;
  }
  if (parsed.options.help) {
    console.log(formatMigrateCliUsage());
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL が設定されていません。");
    process.exitCode = 1;
    return;
  }

  const { schema, extensionSchema, extensionMode } = parsed.options;
  const pool = new Pool({ connectionString });
  try {
    const { applied } = await runMigrations(pool, undefined, {
      schema,
      extensionSchema,
      extensionMode,
    });
    if (applied.length === 0) {
      console.log("適用対象のマイグレーションはありません（すべて適用済み）。");
    } else {
      console.log(`適用したマイグレーション: ${applied.join(", ")}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveAdvisoryLockKey } from "../advisory-lock.js";
import { closePostgresClient, createPostgresClient } from "../client.js";
import {
  DEFAULT_MIGRATIONS_DIR,
  MIGRATION_LOCK_KEY,
  REQUIRED_EXTENSIONS,
  matchCreateExtensionLines,
  migrationLockKeyFor,
} from "../migrate.js";
import {
  DEFAULT_EXTENSION_SCHEMA,
  assertSafeSchemaName,
  qualify,
  qualifiedLiteral,
  searchPathFor,
} from "../schema-namespace.js";
import {
  REGISTER_EMBEDDING_SPACE_LOCK_KEY,
  registerEmbeddingSpaceLockKeyFor,
} from "../vector-space.js";

/**
 * `schema-namespace.ts` とそこに乗る `migrate.ts` / `vector-space.ts` / `client.ts` の
 * 分岐を、**DB 無しで**検査する歯。
 *
 * ⚠ DB を要する検査（実際に `runMigrations` / `registerEmbeddingSpace` を専用スキーマへ
 * 通す・`0001_init.sql` が本当に流れる・`search_path` が DML に効くことを見る等）は
 * **ここには書かない。**それは `dedicated-schema.postgres.test.ts` が持つ。
 * このファイルが測るのは、DB を持たない環境でも走る純関数と設定の組み立てだけである。
 *
 * ⚠ **この分割は「片方が緑なら他方も正しい」を意味しない。**ここの歯は
 * `qualify` が正しい**文字列**を作ることまでしか見ていない——その文字列を
 * PostgreSQL が期待どおりに解釈するかは、`dedicated-schema.postgres.test.ts` が
 * 本物の DB に対してしか測れない。
 */

describe("qualify / qualifiedLiteral", () => {
  it("schema 未指定なら name をそのまま返す（既定経路が今日と変わらないことの要）", () => {
    expect(qualify(undefined, "memories")).toBe("memories");
  });

  it("schema 指定時は両方を二重引用符で囲む", () => {
    expect(qualify("s", "memories")).toBe('"s"."memories"');
  });

  it("qualifiedLiteral は qualify と同じ値を返す（to_regclass の引数として使える形）", () => {
    expect(qualifiedLiteral(undefined, "_mnemora_migrations")).toBe("_mnemora_migrations");
    expect(qualifiedLiteral("s", "_mnemora_migrations")).toBe('"s"."_mnemora_migrations"');
  });
});

describe("assertSafeSchemaName", () => {
  it("通る例: 小文字・アンダースコア始まり・63バイトちょうど", () => {
    expect(() => assertSafeSchemaName("tenant_a")).not.toThrow();
    expect(() => assertSafeSchemaName("_leading_underscore")).not.toThrow();
    const exactly63 = "a".repeat(63);
    expect(Buffer.byteLength(exactly63, "utf8")).toBe(63);
    expect(() => assertSafeSchemaName(exactly63)).not.toThrow();
  });

  it("落ちる例: 大文字を含む", () => {
    expect(() => assertSafeSchemaName("Tenant")).toThrow(/unsafe SQL identifier: Tenant/);
  });

  it("落ちる例: ハイフンを含む", () => {
    expect(() => assertSafeSchemaName("tenant-a")).toThrow(/unsafe SQL identifier: tenant-a/);
  });

  it("落ちる例: 数字始まり", () => {
    expect(() => assertSafeSchemaName("1tenant")).toThrow(/unsafe SQL identifier: 1tenant/);
  });

  it("落ちる例: 空文字", () => {
    expect(() => assertSafeSchemaName("")).toThrow(/unsafe SQL identifier: $/);
  });

  it("落ちる例: 64バイト（63バイトとの境界。文字種は通る名前で長さだけを見る）", () => {
    const exactly64 = "a".repeat(64);
    expect(Buffer.byteLength(exactly64, "utf8")).toBe(64);
    expect(() => assertSafeSchemaName(exactly64)).toThrow(/unsafe SQL schema name/);
  });
});

describe("searchPathFor", () => {
  it("schema と extensionSchema が別なら 'schema,extensionSchema' を返す", () => {
    expect(searchPathFor("s", "public")).toBe("s,public");
  });

  it("同じスキーマなら重複を落として1つだけ返す", () => {
    expect(searchPathFor("s", "s")).toBe("s");
  });
});

describe("migrationLockKeyFor / registerEmbeddingSpaceLockKeyFor", () => {
  it("schema 未指定・'public' は既存の MIGRATION_LOCK_KEY をそのまま返す（ローリングデプロイの互換性）", () => {
    expect(migrationLockKeyFor(undefined)).toBe(MIGRATION_LOCK_KEY);
    expect(migrationLockKeyFor("public")).toBe(MIGRATION_LOCK_KEY);
  });

  it("それ以外の schema は既定と別のキーになり、schema ごとに別々になる", () => {
    expect(migrationLockKeyFor("alt")).not.toBe(MIGRATION_LOCK_KEY);
    expect(migrationLockKeyFor("alt")).not.toBe(migrationLockKeyFor("alt2"));
  });

  it("同じ入力なら毎回同じ値を返す（決定的）", () => {
    expect(migrationLockKeyFor("alt")).toBe(migrationLockKeyFor("alt"));
    expect(registerEmbeddingSpaceLockKeyFor("alt")).toBe(registerEmbeddingSpaceLockKeyFor("alt"));
  });

  it("registerEmbeddingSpaceLockKeyFor も既定は既存定数、それ以外は schema ごとに別値", () => {
    expect(registerEmbeddingSpaceLockKeyFor(undefined)).toBe(REGISTER_EMBEDDING_SPACE_LOCK_KEY);
    expect(registerEmbeddingSpaceLockKeyFor("public")).toBe(REGISTER_EMBEDDING_SPACE_LOCK_KEY);
    expect(registerEmbeddingSpaceLockKeyFor("alt")).not.toBe(REGISTER_EMBEDDING_SPACE_LOCK_KEY);
  });

  it("同じスキーマ名でも migrate 側と register 側は別値になる（互いをブロックしない、ADR 0018 の性質がスキーマ軸でも保たれる）", () => {
    expect(migrationLockKeyFor("alt")).not.toBe(registerEmbeddingSpaceLockKeyFor("alt"));
    expect(migrationLockKeyFor("tenant_x")).not.toBe(registerEmbeddingSpaceLockKeyFor("tenant_x"));
  });
});

describe("deriveAdvisoryLockKey", () => {
  it("MIGRATION_LOCK_KEY / REGISTER_EMBEDDING_SPACE_LOCK_KEY を、各 doc に書かれた seed から再現する", () => {
    expect(deriveAdvisoryLockKey("mnemora:runMigrations:advisory-lock")).toBe(MIGRATION_LOCK_KEY);
    expect(deriveAdvisoryLockKey("mnemora:registerEmbeddingSpace:advisory-lock")).toBe(
      REGISTER_EMBEDDING_SPACE_LOCK_KEY,
    );
  });
});

describe("REQUIRED_EXTENSIONS と migrations/*.sql の突き合わせ", () => {
  it("REQUIRED_EXTENSIONS の集合は migrations/*.sql の CREATE EXTENSION 行の集合と一致する", () => {
    // フィクスチャを手作りしない——実ファイルを読む（架空の世界を測らないため）。
    // 抽出規則（正規表現）は `../migrate.js` の `matchCreateExtensionLines` を呼ぶ
    // ——ここで独自の正規表現を書き写さない。`extensionMode: "verify"`
    // （`stripCreateExtensionStatements`、ADR 0093）も同じ関数を土台にしており、
    // 書き写すと片方だけ直して他方を直し忘れるということが起き得るため
    // （`assertSafeSchemaName` の doc と同じ理由）。
    const files = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
    const found = new Set<string>();
    for (const file of files) {
      const sql = readFileSync(join(DEFAULT_MIGRATIONS_DIR, file), "utf8");
      for (const { name } of matchCreateExtensionLines(sql)) {
        found.add(name);
      }
    }
    expect(new Set(REQUIRED_EXTENSIONS)).toEqual(found);
  });
});

describe("createPostgresClient", () => {
  const CONNECTION_STRING = "postgresql://user:pass@localhost:5432/db";

  it("schema 未指定なら pool.options.options に一切触らない（new Pool は接続しないので DB 無しで検査できる）", async () => {
    const client = createPostgresClient(CONNECTION_STRING);
    try {
      expect((client.pool.options as { options?: string }).options).toBeUndefined();
    } finally {
      await closePostgresClient(client);
    }
  });

  it("schema 指定時、pool.options.options に -c search_path=... が載る", async () => {
    const client = createPostgresClient(CONNECTION_STRING, { schema: "tenant_a" });
    try {
      expect((client.pool.options as { options?: string }).options).toBe(
        `-c search_path=tenant_a,${DEFAULT_EXTENSION_SCHEMA}`,
      );
    } finally {
      await closePostgresClient(client);
    }
  });

  it("呼び出し側が既に config.options を渡していたら、後ろに空白区切りで追記する（上書きしない）", async () => {
    const client = createPostgresClient(CONNECTION_STRING, {
      schema: "tenant_a",
      options: "-c statement_timeout=5000",
    });
    try {
      expect((client.pool.options as { options?: string }).options).toBe(
        `-c statement_timeout=5000 -c search_path=tenant_a,${DEFAULT_EXTENSION_SCHEMA}`,
      );
    } finally {
      await closePostgresClient(client);
    }
  });

  it("schema / extensionSchema が pool.options にそのまま漏れていない", async () => {
    const client = createPostgresClient(CONNECTION_STRING, {
      schema: "tenant_a",
      extensionSchema: "ext",
    });
    try {
      const options = client.pool.options as unknown as Record<string, unknown>;
      expect(options.schema).toBeUndefined();
      expect(options.extensionSchema).toBeUndefined();
      expect(options.options).toBe("-c search_path=tenant_a,ext");
    } finally {
      await closePostgresClient(client);
    }
  });
});

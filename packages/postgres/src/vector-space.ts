import type { Pool } from "pg";
import type { EmbeddingSpaceId } from "@mnemora/core";
import {
  assertSafeIdentifier,
  embeddingSpaceIndexName,
  embeddingSpaceTableName,
} from "./embedding-space-table.js";
import {
  AdvisoryLockTimeoutError,
  AdvisoryLockUnavailableError,
  DEFAULT_LOCK_TIMEOUT_MS,
  acquireAdvisoryLock,
  deriveAdvisoryLockKey,
  releaseAdvisoryLock,
} from "./advisory-lock.js";
import {
  DEFAULT_EXTENSION_SCHEMA,
  type SchemaNamespaceOptions,
  assertSafeSchemaName,
  qualify,
} from "./schema-namespace.js";

/**
 * `registerEmbeddingSpace` がプロセス間排他に使う advisory lock のキー（段階2・ADR 0018）。
 *
 * `MIGRATION_LOCK_KEY`（`./migrate.ts`）と**意図的に別の値**にしてある——`runMigrations`
 * と `registerEmbeddingSpace` が互いを無関係にブロックしないため（同じキーを使うと、
 * 例えば「マイグレーション中の別プロセス」が「埋め込み空間を登録しようとしたプロセス」を
 * 意図せず待たせることになる）。
 *
 * `MIGRATION_LOCK_KEY` と**同じ導出手順**（固定文字列
 * `"mnemora:registerEmbeddingSpace:advisory-lock"` の SHA-256 先頭8バイトを符号付き64bit
 * 整数として解釈した値）で計算してあり、**実行時に変わらない定数**としてハードコードして
 * ある（`node -e 'const c=require("crypto");console.log(c.createHash("sha256").update("mnemora:registerEmbeddingSpace:advisory-lock").digest().readBigInt64BE(0).toString())'`
 * で再計算できる。値そのものに意味は無く、衝突回避のためだけに存在する）。
 *
 * **埋め込み空間ごとにキーを分けない**（`EmbeddingSpaceId` から導出したりしない）。
 * 理由と引き受けるトレードオフ（別空間の同時登録が直列化される）は ADR 0018 参照。
 *
 * 値を変えると、新旧のプロセスが違うキーで別々にロックを取り、排他が効かなくなる
 * ため、ローリングデプロイ中の互換性が壊れる。変える理由が生まれたら ADR を書くこと。
 */
export const REGISTER_EMBEDDING_SPACE_LOCK_KEY = -4359922960011245935n;

export interface RegisterEmbeddingSpaceOptions extends SchemaNamespaceOptions {
  /** advisory lock を待つ上限（ミリ秒）。既定は {@link DEFAULT_LOCK_TIMEOUT_MS}。 */
  lockTimeoutMs?: number;
  /** advisory lock のキー。テスト以外で既定の {@link REGISTER_EMBEDDING_SPACE_LOCK_KEY} を変える理由は無い。 */
  lockKey?: bigint;
}

/**
 * `schema` から `registerEmbeddingSpace` の advisory lock キーを導く（feat/dedicated-schema）。
 *
 * `migrationLockKeyFor`（`./migrate.ts`）と**同じ規則**（`schema === undefined` または
 * `"public"` なら既存の {@link REGISTER_EMBEDDING_SPACE_LOCK_KEY} を、それ以外は
 * `deriveAdvisoryLockKey` で `schema` ごとに導出したキーを返す）。理由も同じ——
 * ローリングデプロイ中の旧プロセスとの排他を壊さないため、既定経路のキーは変えない。
 *
 * ⚠ **ADR 0018 は「埋め込み空間ごとにキーを分けない」と決めている。** ここで分けるのは
 * **スキーマ**の軸であって**空間**の軸ではない——`EmbeddingSpaceId` は一切関与しない。
 * ADR 0018 の決定（別空間の同時登録は直列化されるトレードオフを引き受ける）はそのまま
 * 保たれる。`schema` ごとに別キーにする理由は `migrationLockKeyFor` と同一で、
 * 「2つの mnemora が同じ DB の別スキーマに同居すると、片方の registerEmbeddingSpace が
 * もう片方を黙ってブロックする」ことを防ぐため。
 */
export function registerEmbeddingSpaceLockKeyFor(schema?: string): bigint {
  if (schema === undefined || schema === "public") {
    return REGISTER_EMBEDDING_SPACE_LOCK_KEY;
  }
  return deriveAdvisoryLockKey(`mnemora:registerEmbeddingSpace:advisory-lock:${schema}`);
}

export interface RegisterEmbeddingSpaceResult {
  /**
   * 排他の観測値。`waitedMs` は「ロックが空くまで実際に待った時間」（ミリ秒）。
   * 他プロセスが同時に registerEmbeddingSpace を呼んでいなければ 0 に近い値になる。
   * `runMigrations` の `RunMigrationsResult.lock` と同じ形（ADR 0018、「学ぶことが
   * 1つで済む」という要求に対応する）。
   */
  lock: { waitedMs: number };
}

/**
 * advisory lock の取得が「待ち時間切れで失敗した」ことを表す。`registerEmbeddingSpace` 版。
 * 詳細は `./advisory-lock.ts` の `AdvisoryLockTimeoutError` と
 * `./migrate.ts` の `MigrationLockTimeoutError` を参照（同じ3状態の区別をここでも保つ）。
 */
export class RegisterEmbeddingSpaceLockTimeoutError extends AdvisoryLockTimeoutError {
  constructor(waitedMs: number, cause: unknown) {
    super(
      `registerEmbeddingSpace: advisory lock を ${waitedMs}ms 待ったが取得できなかった` +
        `（タイムアウト）。他プロセスが registerEmbeddingSpace を握ったまま応答していない可能性がある。`,
      cause,
    );
    this.name = "RegisterEmbeddingSpaceLockTimeoutError";
  }
}

/**
 * advisory lock を取得する**操作自体**が失敗したことを表す。`registerEmbeddingSpace` 版。
 * 権限不足・接続不可などが原因で、待ち時間切れ（`RegisterEmbeddingSpaceLockTimeoutError`）
 * とは別物として区別できる。
 */
export class RegisterEmbeddingSpaceLockUnavailableError extends AdvisoryLockUnavailableError {
  constructor(cause: unknown) {
    super(
      `registerEmbeddingSpace: advisory lock を取得する操作自体が失敗した` +
        `（権限不足・接続不可などで、待ち時間切れとは別の原因）。`,
      cause,
    );
    this.name = "RegisterEmbeddingSpaceLockUnavailableError";
  }
}

const REGISTER_EMBEDDING_SPACE_LOCK_ERRORS = {
  timeout: (waitedMs: number, cause: unknown) =>
    new RegisterEmbeddingSpaceLockTimeoutError(waitedMs, cause),
  unavailable: (cause: unknown) => new RegisterEmbeddingSpaceLockUnavailableError(cause),
};

/**
 * 埋め込み空間ごとのテーブル（`memory_embeddings_<space>`）を登録する
 * （docs/memory-model.md §10「決定: 埋め込み空間を登録する操作の一部として...テーブルを作る」）。
 *
 * `migrate.ts`（`migrations/*.sql`）とは別の口だが、同じ規約に従う——
 * **DDL はすべてこの関数の中に手書きで置き、drizzle-kit には一切頼らない**
 * （ADR 0001）。HNSW 索引の operator class もここで明示する。
 *
 * ## 排他（段階2・ADR 0018）
 *
 * **`IF NOT EXISTS` は「べき等」であって「並行安全」ではない。** 単独プロセスから
 * 何度呼んでも同じ結果に収束する（べき等）が、`CREATE TABLE IF NOT EXISTS` /
 * `CREATE INDEX IF NOT EXISTS` はいずれも「存在チェック」と「作成」がアトミックではない
 * ため、複数プロセスが同時に呼ぶと**決定的に**（段階1の実測で試行した全件で）どちらか
 * 一方が `duplicate key value violates unique constraint` で落ちる
 * （テーブル層は `pg_type_typname_nsp_index`、索引層は `pg_class_relname_nsp_index`。
 * 詳細は ADR 0018）。そのため呼び出し全体を advisory lock
 * （`REGISTER_EMBEDDING_SPACE_LOCK_KEY`）で包む——`runMigrations`（ADR 0017）と
 * 同じ機構を `./advisory-lock.ts` から共有している。
 *
 * バリデーション（`dimensions` の検査・識別子の安全性チェック）は**ロック取得より前**に
 * 行う——不正な入力のためにロックを取って他プロセスを待たせる意味が無いため。
 *
 * 起こりうる3つの状態（`runMigrations` と同じ語彙、オーナーが引いた線1）:
 * - 待って取れた → 通常どおり完了し、戻り値の `lock.waitedMs` に待った時間が載る
 * - 待ったが時間切れ → {@link RegisterEmbeddingSpaceLockTimeoutError} を投げる
 *   （黙って続行しない）
 * - ロック取得の操作自体が失敗（権限不足・接続不可等） →
 *   {@link RegisterEmbeddingSpaceLockUnavailableError} を投げる（時間切れと取り違えない）
 *
 * テーブル名・索引名は `EmbeddingSpaceId` から機械的に導出するため、呼び出し側が
 * 直接テーブル名を書く必要はない（`VectorStore` 実装がこの関数と同じ導出規則を使う）。
 *
 * ## `options.schema`（feat/dedicated-schema）
 *
 * **`schema` 未指定なら、発行される DDL は今日と1バイトも変わらない**（`qualify` が
 * 識別子を素通しするため）。`schema` を指定すると、テーブル・外部キー参照先・索引を
 * `qualify(schema, ...)` で完全修飾し、`vector` / `vector_cosine_ops` の型・operator
 * class を `qualify(extensionSchema, ...)` で修飾する（`extensionSchema` 省略時は
 * {@link DEFAULT_EXTENSION_SCHEMA}）。**`search_path` は一切触らない**——`migrate.ts`
 * の `SET LOCAL` と違い、`registerEmbeddingSpace` は `pool.query` を直接使う
 * （専用コネクションを保持しない）ため、`SET LOCAL` で守れる範囲のトランザクションを
 * 持たない。完全修飾すれば `search_path` に依存する必要が無く、pool のコネクションに
 * session 状態を残す心配も無くなる。
 *
 * **索引名は修飾しない**——索引は常にテーブルと同じスキーマに作られるので、
 * `CREATE INDEX ... ON <table>` の索引名の位置にスキーマ修飾を書くと構文エラーになる。
 */
export async function registerEmbeddingSpace(
  pool: Pool,
  space: EmbeddingSpaceId,
  options: RegisterEmbeddingSpaceOptions = {},
): Promise<RegisterEmbeddingSpaceResult> {
  if (!Number.isInteger(space.dimensions) || space.dimensions <= 0) {
    throw new Error(`invalid embedding space dimensions: ${space.dimensions}`);
  }

  const { schema } = options;
  if (schema !== undefined) {
    assertSafeSchemaName(schema);
  }
  const extensionSchema =
    schema === undefined ? undefined : (options.extensionSchema ?? DEFAULT_EXTENSION_SCHEMA);
  if (extensionSchema !== undefined) {
    assertSafeSchemaName(extensionSchema);
  }

  const table = embeddingSpaceTableName(space);
  const index = embeddingSpaceIndexName(space);
  assertSafeIdentifier(table);
  assertSafeIdentifier(index);

  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const lockKey = options.lockKey ?? registerEmbeddingSpaceLockKeyFor(schema);

  const { client: lockClient, waitedMs } = await acquireAdvisoryLock(
    pool,
    lockKey,
    lockTimeoutMs,
    REGISTER_EMBEDDING_SPACE_LOCK_ERRORS,
  );
  try {
    // dimensions は上で正整数であることを確認済みなので、そのまま埋め込んでよい
    // （パラメータ化できない — vector(N) の N は SQL の識別子/型修飾子の位置にある）。
    // `"public"."vector"(1536)` は正しい型構文である（`qualify` が schema 未指定なら
    // 素通しするので、schema 未指定時は今日と同じ `vector(1536)` になる）。
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${qualify(schema, table)} (
        tenant_id   text         NOT NULL,
        memory_id   uuid         NOT NULL REFERENCES ${qualify(schema, "memories")}(id) ON DELETE CASCADE,
        embedding   ${qualify(extensionSchema, "vector")}(${space.dimensions}) NOT NULL,
        model       text         NOT NULL,
        created_at  timestamptz  NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, memory_id)
      );
    `);

    // HNSW 索引。operator class を明示する（cosine 距離を採用する。
    // docs/memory-model.md §10 の例と同じ形）。索引名は修飾しない（索引は
    // テーブルと同じスキーマに作られる）。
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${index}
        ON ${qualify(schema, table)}
        USING hnsw (embedding ${qualify(extensionSchema, "vector_cosine_ops")});
    `);
  } finally {
    await releaseAdvisoryLock(lockClient, lockKey);
  }

  return { lock: { waitedMs } };
}

import { assertSafeIdentifier } from "./embedding-space-table.js";

/**
 * 専用スキーマ（namespace）対応の共通部品（feat/dedicated-schema）。
 *
 * ## 背景
 *
 * 共有 DB の中に他システムが同名テーブル（`memories` 等の裸の名前）を持っていても
 * 衝突しないように、`@mnemora/postgres` の使う側が専用の PostgreSQL スキーマを
 * 指定できるようにする。設計は決まっている——採った形は
 * 「DML は `search_path` に任せ、DDL と存在検査は明示修飾する」。
 *
 * - DML（`memory-store.ts` / `vector-store.ts` / `event-store.ts` / `outbox-store.ts` /
 *   `tenant-settings-store.ts` の生 SQL）は裸のテーブル名しか使わない。接続の
 *   `search_path` の先頭を `<schema>` にすれば、これらは1行も変えずに正しいスキーマを
 *   指す（`./client.ts` の `createPostgresClient` が担う）。
 * - DDL（マイグレーション・`registerEmbeddingSpace`）と存在検査（`to_regclass` 等）は
 *   `search_path` に頼らず、この `qualify` / `qualifiedLiteral` でスキーマ修飾する。
 *   `to_regclass('_mnemora_migrations')` は `search_path` 全体を探すため、`public` に
 *   台帳が在ると `<schema>` の台帳が無くても「在る」と誤判定する
 *   （`migrate-ledger-handover.test.ts` の doc が記録している実害そのもの）。
 *   `CREATE TABLE IF NOT EXISTS` の可視性判定も同じ危険を持つ。
 *
 * ## `schema` を指定しない既定の経路
 *
 * **発行される SQL 文字列が今日と1バイトも変わらないこと**を最優先の線として引いてある。
 * このファイルの関数はすべて `schema === undefined` を特別扱いし、そのときは
 * 何も付け足さずに素通しする。新しい振る舞い（`SET search_path` / `CREATE SCHEMA` /
 * `CREATE EXTENSION` の事前実行）は、`schema` が実際に指定されたときだけ起きる。
 */

/**
 * `schema` を指定したときに、拡張（`vector` / `btree_gin` / `pgcrypto`）を置く
 * 既定のスキーマ。PostgreSQL 自体の既定と揃えてあり、`schema` の指定が無ければ
 * 一切参照されない（`extensionSchema` は `schema` を指定したときだけ効く）。
 */
export const DEFAULT_EXTENSION_SCHEMA = "public";

export interface SchemaNamespaceOptions {
  /**
   * mnemora のテーブル・索引・マイグレーション台帳を置くスキーマ。
   * **省略時は接続の `search_path` 任せ**（＝今日どおりの振る舞い。既定では
   * `SET search_path` も `CREATE SCHEMA` も一切発行しない）。
   */
  schema?: string;
  /**
   * `vector` / `btree_gin` / `pgcrypto` を置くスキーマ。**`schema` を指定したときだけ効く。**
   * 既定は {@link DEFAULT_EXTENSION_SCHEMA}。
   */
  extensionSchema?: string;
}

/** PostgreSQL の識別子の上限（NAMEDATALEN - 1）。`embedding-space-table.ts` の
 * `MAX_IDENTIFIER_BYTES` と同じ根拠だが、あちらは private なのでここで定義し直す。 */
const MAX_SCHEMA_NAME_BYTES = 63;

/**
 * スキーマ名として安全であることを検査する。
 *
 * 文字種の検査（`^[a-z_][a-z0-9_]*$`）は `embedding-space-table.ts` の
 * `assertSafeIdentifier` を**そのまま呼んで**行う——正規表現を書き写すと、片方だけ
 * 直して他方を直し忘れるということが起き得るため（このリポジトリの規律、
 * `AGENTS.md` 「正典と実装が食い違ったら」と同じ理由）。
 *
 * それに加えて、ここでは **UTF-8 で 63 バイトを超えたら投げる**。PostgreSQL の
 * 識別子は NAMEDATALEN（既定 64）から終端文字を引いた 63 バイトまでしか保持しない
 * ——`assertSafeIdentifier` はテーブル名・索引名向けの検査で文字種しか見ないため、
 * スキーマ名専用にここで長さも見る。文字種の失敗と長さの失敗はメッセージで
 * 区別できるようにしてある（呼び出し側が原因を取り違えないように）。
 */
export function assertSafeSchemaName(schema: string): void {
  assertSafeIdentifier(schema);
  if (Buffer.byteLength(schema, "utf8") > MAX_SCHEMA_NAME_BYTES) {
    throw new Error(
      `unsafe SQL schema name: ${schema} (${Buffer.byteLength(schema, "utf8")} bytes, ` +
        `limit is ${MAX_SCHEMA_NAME_BYTES} bytes — PostgreSQL の NAMEDATALEN 制限)`,
    );
  }
}

/**
 * SQL 文の中で使う、スキーマ修飾済みの識別子を組み立てる。
 *
 * `schema === undefined` のときは `name` をそのまま返す——**既定経路が今日と
 * 1バイトも変わらないことは、この分岐そのものが担っている。** それ以外では
 * `"<schema>"."<name>"` と両方を二重引用符で囲む（大文字小文字を区別させ、
 * 予約語・記号を含む名前でも安全にするため）。
 */
export function qualify(schema: string | undefined, name: string): string {
  if (schema === undefined) {
    return name;
  }
  return `"${schema}"."${name}"`;
}

/**
 * `to_regclass('...')` のようにシングルクォート文字列の**中に置く**識別子を組み立てる。
 *
 * **`qualify` をそのまま使い回している。** 理由: シングルクォート文字列の中に置く
 * 相手は二重引用符付き識別子（`"s"."t"` / `t`）であり、`to_regclass` はこの形式を
 * そのまま受け付ける（`to_regclass('"s"."t"')` は正しく動く——`assertSafeSchemaName` /
 * `assertSafeIdentifier` を通した名前しか渡さない前提なので、名前自体に
 * シングルクォートが混じる心配は無い）。実体が同じであるため、別関数として
 * 実装を複製せず、意図を示す別名としてだけ用意する。
 */
export function qualifiedLiteral(schema: string | undefined, name: string): string {
  return qualify(schema, name);
}

/**
 * libpq の startup parameter `options`（`-c search_path=...`）および
 * セッション内の `SET search_path` の両方で使える値を返す。
 *
 * **引用符を付けない。** `schema` / `extensionSchema` は呼び出し側で
 * `assertSafeSchemaName` を通した後の値である前提であり、`^[a-z_][a-z0-9_]*$` に
 * 収まる（空白・記号・大文字を含まない）ことが分かっている。`options` の startup
 * parameter の中では、値の中の空白がパラメータの区切りとして解釈されるため、
 * クォートやエスケープを別途持ち込むと `options` 全体の組み立てが厄介になる
 * （`client.ts` 側で既存の `options` 文字列に空白区切りで追記する形と噛み合わせる
 * 必要もある）。識別子を検証済みという前提の上で、引用符を持ち込まない方を選んだ。
 *
 * `schema === extensionSchema` のときは重複を落として1つだけ返す
 * （`search_path=s,s` のような冗長な値にしない）。
 */
export function searchPathFor(schema: string, extensionSchema: string): string {
  if (schema === extensionSchema) {
    return schema;
  }
  return `${schema},${extensionSchema}`;
}

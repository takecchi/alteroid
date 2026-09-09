import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles, runMigrations } from "../migrate.js";

/**
 * `packages/postgres/src/bin/migrate.ts` の doc コメントに書かれた主張を、
 * DB 無しで実際に検査する歯（Issue #107）。
 *
 * ## 何を守っているか
 *
 * `migrate.ts`（CLI）は `--schema` / `MNEMORA_SCHEMA` の指定が無いとき
 * `runMigrations(pool, undefined, { schema: undefined, extensionSchema: undefined })` を
 * 呼ぶ。この doc は「options 省略時（`runMigrations(pool)`）と1バイトも変わらない」と
 * 主張しているが、それは `../migrate.ts` の `runMigrations` が内部で
 * `schema === undefined` を分岐の起点にしていることに依存している——**その分岐が
 * 将来変わったとき**（例: `extensionSchema` の既定値を `schema` 未指定でも適用して
 * しまう、`schema` 未指定でも `CREATE SCHEMA` を打ってしまう、等）に、この歯が
 * 気付ける形にする。
 *
 * ⭐ 併せて、既定の migrations ディレクトリの解決（`../migrations-dir.cts`、
 * Issue #110）が生きていることも測る。`migrationsDir` を省略して
 * {@link DEFAULT_MIGRATIONS_DIR} を実際に使わせるため、`../migrations-dir.cts` の
 * `join(__dirname, "..", "migrations")` が壊れれば `listMigrationFiles` が `ENOENT` で
 * 落ち、この歯が赤くなる。
 *
 * ## どう測るか
 *
 * `runMigrations` が触る面は `pool.query(...)` と `pool.connect()`（返す client の
 * `query` / `release`）だけ（`../migrate.ts` と `../advisory-lock.ts` を参照）。
 * その2つを記録するだけの偽の `Pool` を作り、
 *
 * - A: `runMigrations(fakeA)`（引数1つ）
 * - B: `runMigrations(fakeB, undefined, { schema: undefined, extensionSchema: undefined })`
 *
 * の発行 SQL 列が完全に一致することを確かめる。
 *
 * ⚠ 両方の列が空でも「一致」はしてしまう——それでは何も測っていない。そのため
 * 「列が空でない・実マイグレーション本文が流れている」ことと、「schema を実際に
 * 指定すれば列が変わる」という対照（negative control）を別の `it` として置く。
 *
 * ⚠ このファイルは `test-db.ts` を import しない（`DATABASE_URL` を要求しない）。
 * DB を要する検査は `dedicated-schema.postgres.test.ts` 等、別ファイルの役目。
 */

/** `runMigrations` が発行した SQL を記録するだけの偽の `Pool` と、その記録先の配列。 */
function createFakePool(): { pool: Pool; log: string[] } {
  const log: string[] = [];

  const client = {
    query: async (text: string) => {
      log.push(`client.query: ${text}`);
      return { rows: [] };
    },
    release: () => {
      // 記録することは何も無い（呼ばれたことそのものは検査対象ではない）。
    },
  };

  const pool = {
    query: async (text: string) => {
      log.push(`pool.query: ${text}`);
      return { rows: [] };
    },
    connect: async () => client,
  };

  return { pool: pool as unknown as Pool, log };
}

describe("migrate.ts CLI の既定経路: options 省略と1バイトも変わらない", () => {
  it("A: runMigrations(pool) と B: runMigrations(pool, undefined, { schema: undefined, extensionSchema: undefined }) は同じ SQL 列を発行する", async () => {
    const a = createFakePool();
    const b = createFakePool();

    await runMigrations(a.pool);
    await runMigrations(b.pool, undefined, { schema: undefined, extensionSchema: undefined });

    expect(b.log).toEqual(a.log);

    // A と B は「schema を渡す/渡さない」に関わらず runtime 上は同じ値（undefined）を
    // 見るので、`schema === undefined` の分岐そのものが壊れて専用スキーマ用の SQL を
    // 打つようになった場合、A と B は"同じように"壊れ、上の toEqual だけでは互いに
    // 見分けが付かない（両方に紛れ込むため）。**そのため既定経路には専用スキーマ用の
    // SQL（`CREATE SCHEMA` / `SET LOCAL search_path`）が一切現れないことを、この列
    // 自体に対しても直接固定する。**
    //
    // ⚠ `CREATE EXTENSION` はここでは見ない——`migrations/0001_init.sql` 自身が
    // （意図的な二重管理として、`../migrate.ts` の `REQUIRED_EXTENSIONS` の doc 参照）
    // `CREATE EXTENSION IF NOT EXISTS vector;` 等を本文に含むため、実マイグレーション
    // 本文が正しく流れている限り正当に現れる。
    for (const entry of a.log) {
      expect(entry).not.toMatch(/CREATE SCHEMA/);
      expect(entry).not.toMatch(/SET LOCAL search_path/);
    }
  });

  it("空振り防止: 列は空でなく、既定の migrations ディレクトリの実ファイルが実際に流れる（Issue #110 の migrations-dir.cts が生きていることも測る）", async () => {
    const { pool, log } = createFakePool();

    await runMigrations(pool);

    expect(log.length).toBeGreaterThan(0);

    // 期待値をハードコードしない——listMigrationFiles(DEFAULT_MIGRATIONS_DIR) から導出する
    // （過去にハードコードで6件転んだ記録が ../migrate.ts の doc に残っている）。
    const files = listMigrationFiles(DEFAULT_MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const sql = readFileSync(join(DEFAULT_MIGRATIONS_DIR, file), "utf8");
      expect(log.some((entry) => entry.includes(sql))).toBe(true);
    }
  });

  it("対照(negative control): schema を実際に指定すれば SQL 列は変わり、CREATE SCHEMA / SET LOCAL search_path が現れる", async () => {
    const a = createFakePool();
    const c = createFakePool();

    await runMigrations(a.pool);
    await runMigrations(c.pool, undefined, { schema: "some_schema" });

    // これが無いと「比較が何も検出できない壊れた比較」でも上の歯は緑になってしまう。
    expect(c.log).not.toEqual(a.log);
    expect(c.log.some((entry) => /CREATE SCHEMA/.test(entry))).toBe(true);
    expect(c.log.some((entry) => /SET LOCAL search_path/.test(entry))).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIGRATIONS_DIR,
  MissingExtensionsError,
  REQUIRED_EXTENSIONS,
  matchCreateExtensionLines,
  runMigrations,
  stripCreateExtensionStatements,
} from "../migrate.js";

/**
 * `extensionMode: "verify"`（ADR 0093）を **DB 無しで**検査する歯。
 *
 * ## 動機（ADR 0093 参照）
 *
 * mnemora は既定で `CREATE EXTENSION` を勝手に発行する。`CREATE EXTENSION` 権限を
 * 持たないロールで接続する導入者（実例: virchamate、DB オーナーが承認したのは
 * `btree_gin` / `pgcrypto` の2文だけで、mnemora が発行する `vector` は承認された
 * 範囲の外にある）を締め出さないため、「発行しない代わりに、在ることを検査する」口を足す。
 *
 * ## 難所（2経路）
 *
 * `CREATE EXTENSION` は2経路ある: (1) `runMigrations` が `schema` 指定時だけ発行する
 * `REQUIRED_EXTENSIONS` ループ、(2) `migrations/0001_init.sql` 本文に手書きされた3行
 * （`schema` の有無に関わらず必ず流れる）。`extensionMode: "verify"` は両方を塞ぐ
 * ——(1) はループそのものを丸ごとスキップし、(2) は送信前に `CREATE EXTENSION` 行だけを
 * 取り除く（`stripCreateExtensionStatements`）。この歯は両方を測る。
 *
 * ## なぜ DB を要する歯（`extension-mode.postgres.test.ts`）と分けるか
 *
 * `migrate-default-path-unchanged.test.ts` と同じ理由: 偽の `Pool`（発行された SQL 文字列を
 * 記録するだけ）で「何を発行し、何を発行しなかったか」は確認できる。「`CREATE EXTENSION`
 * 権限を持たない本物のロールで実際に動くか」は本物の PostgreSQL が要るため、そちらに譲る。
 */

const REAL_0001_SQL = readFileSync(join(DEFAULT_MIGRATIONS_DIR, "0001_init.sql"), "utf8");

describe("matchCreateExtensionLines / stripCreateExtensionStatements: 0001_init.sql の実ファイルに対して", () => {
  it("0001_init.sql から検出される拡張名は REQUIRED_EXTENSIONS と同じ集合・同じ順序で並ぶ", () => {
    const matches = matchCreateExtensionLines(REAL_0001_SQL);
    expect(matches.map((m) => m.name)).toEqual([...REQUIRED_EXTENSIONS]);
  });

  it("取り除いた行の集合は REQUIRED_EXTENSIONS と一致し、本文からは1つも見当たらなくなる", () => {
    const { sql, removed } = stripCreateExtensionStatements(REAL_0001_SQL);
    expect(new Set(removed)).toEqual(new Set(REQUIRED_EXTENSIONS));
    expect(sql).not.toMatch(/CREATE EXTENSION/);
  });

  it("取り除いた行以外は1バイトも変わらない（独立な検証: 既知の3つの完全一致行だけを行単位で除いた結果と一致する）", () => {
    // 生成に使ったのと同じ正規表現を再利用しない——独立した検証にするため、
    // 「既知の3つの行そのもの」を文字列としてベタ書きして比較する。
    const KNOWN_LINES = [
      "CREATE EXTENSION IF NOT EXISTS vector;",
      "CREATE EXTENSION IF NOT EXISTS btree_gin;",
      "CREATE EXTENSION IF NOT EXISTS pgcrypto;",
    ];
    const expectedLines = REAL_0001_SQL.split("\n").filter(
      (line) => !KNOWN_LINES.includes(line.trim()),
    );
    const { sql } = stripCreateExtensionStatements(REAL_0001_SQL);
    expect(sql.split("\n")).toEqual(expectedLines);

    // 空振り防止: 除いた側には実際に3行あった（フィルタが誤って全部/何も一致しない、を防ぐ）。
    expect(REAL_0001_SQL.split("\n").length - expectedLines.length).toBe(3);

    // テーブル定義などの残りの本文は無傷であることも直接示す。
    expect(sql).toContain("CREATE TABLE observations");
  });

  it("コメント中の CREATE EXTENSION 風の文字列は取り除かない（行頭一致のみ）", () => {
    const sql =
      "-- see CREATE EXTENSION IF NOT EXISTS vector; for context\nCREATE TABLE t (id int);";
    const { sql: stripped, removed } = stripCreateExtensionStatements(sql);
    expect(removed).toEqual([]);
    expect(stripped).toBe(sql);
  });

  it("WITH SCHEMA 付きの CREATE EXTENSION（現状の migrations/*.sql には存在しない形）は対象外", () => {
    const sql =
      'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA "ext";\nCREATE TABLE t (id int);';
    const { sql: stripped, removed } = stripCreateExtensionStatements(sql);
    expect(removed).toEqual([]);
    expect(stripped).toBe(sql);
  });
});

describe("MissingExtensionsError: メッセージに足りない拡張名と実行すべき SQL が具体的に載る", () => {
  it("extensionSchema 未指定: WITH SCHEMA を付けない SQL を提案する", () => {
    const err = new MissingExtensionsError(["vector"], undefined);
    expect(err.missing).toEqual(["vector"]);
    expect(err.message).toContain("vector");
    expect(err.message).toContain("CREATE EXTENSION IF NOT EXISTS vector;");
    expect(err.message).not.toContain("WITH SCHEMA");
  });

  it("extensionSchema 指定あり: WITH SCHEMA 付きの SQL を提案する", () => {
    const err = new MissingExtensionsError(["vector", "btree_gin"], "ext");
    expect(err.message).toContain('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA "ext";');
    expect(err.message).toContain('CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA "ext";');
  });

  it("instanceof Error で捕捉できる（MissingExtensionsError 専用の判別ができる）", () => {
    const err = new MissingExtensionsError(["pgcrypto"], undefined);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("MissingExtensionsError");
  });
});

/**
 * `runMigrations` が発行した SQL を記録するだけの偽の `Pool`。
 * `../__tests__/migrate-default-path-unchanged.test.ts` と同じ形だが、
 * `pg_extension` への問い合わせだけ差し替えられた行を返せるようにしてある
 * （それ以外は今までどおり `{ rows: [] }`）。
 */
function createFakePool(options: { extensionRows?: readonly string[] } = {}): {
  pool: Pool;
  log: string[];
  connectCounter: { count: number };
} {
  const log: string[] = [];
  const connectCounter = { count: 0 };

  const client = {
    query: async (text: string) => {
      log.push(`client.query: ${text}`);
      return { rows: [] };
    },
    release: () => {},
  };

  const pool = {
    query: async (text: string) => {
      log.push(`pool.query: ${text}`);
      if (/FROM pg_extension/.test(text)) {
        return { rows: (options.extensionRows ?? []).map((extname) => ({ extname })) };
      }
      return { rows: [] };
    },
    connect: async () => {
      connectCounter.count += 1;
      return client;
    },
  };

  return { pool: pool as unknown as Pool, log, connectCounter };
}

describe("runMigrations({ extensionMode: 'verify' })", () => {
  it("既定（extensionMode 省略）は今日どおり CREATE EXTENSION を発行し、extensionCheck は undefined（『検査していない』）", async () => {
    const { pool, log } = createFakePool();
    const result = await runMigrations(pool);

    expect(result.extensionCheck).toBeUndefined();
    expect(log.some((entry) => entry.includes("CREATE EXTENSION IF NOT EXISTS vector;"))).toBe(
      true,
    );
  });

  it("全部揃っている場合: CREATE EXTENSION を一切発行せず完了し、extensionCheck.verified に載る（『在った』）", async () => {
    const { pool, log } = createFakePool({ extensionRows: [...REQUIRED_EXTENSIONS] });

    const result = await runMigrations(pool, undefined, { extensionMode: "verify" });

    expect(result.extensionCheck).toEqual({ verified: REQUIRED_EXTENSIONS });
    for (const entry of log) {
      expect(entry).not.toMatch(/CREATE EXTENSION/);
    }
    // 空振り防止: マイグレーション本文自体は実際に流れている
    // （CREATE EXTENSION の3行を除いた残りが届いていることを直接示す）。
    expect(log.some((entry) => entry.includes("CREATE TABLE observations"))).toBe(true);
  });

  it("足りない拡張がある場合: MissingExtensionsError を投げ、ロック取得も含め一切 DB へ触らない（『検査したが無かった』）", async () => {
    const { pool, log, connectCounter } = createFakePool({ extensionRows: ["vector"] });

    const err = await runMigrations(pool, undefined, { extensionMode: "verify" }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MissingExtensionsError);
    expect((err as InstanceType<typeof MissingExtensionsError>).missing).toEqual([
      "btree_gin",
      "pgcrypto",
    ]);

    // pg_extension への問い合わせ1回だけで決着している——advisory lock の取得
    // （pool.connect）も、CREATE SCHEMA も、マイグレーション本文も一切発行していない。
    expect(log).toEqual([
      `pool.query: SELECT extname FROM pg_extension WHERE extname = ANY(ARRAY['vector', 'btree_gin', 'pgcrypto'])`,
    ]);
    expect(connectCounter.count).toBe(0);
  });

  it("schema 指定 + verify: CREATE SCHEMA は発行するが CREATE EXTENSION は発行しない（経路1が塞がることの対照）", async () => {
    const { pool, log } = createFakePool({ extensionRows: [...REQUIRED_EXTENSIONS] });

    await runMigrations(pool, undefined, { schema: "some_schema", extensionMode: "verify" });

    expect(log.some((entry) => /CREATE SCHEMA/.test(entry))).toBe(true);
    for (const entry of log) {
      expect(entry).not.toMatch(/CREATE EXTENSION/);
    }
  });

  it("負の対照: schema 指定 + create（既定）なら CREATE EXTENSION ... WITH SCHEMA が発行される", async () => {
    const { pool, log } = createFakePool();

    await runMigrations(pool, undefined, { schema: "some_schema" });

    expect(
      log.some((entry) => /CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA "public"/.test(entry)),
    ).toBe(true);
  });
});

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * `mnemora-postgres-migrate`（`../bin/migrate.ts`）を**実際に子プロセスとして起動し**、
 * DB へ触る前に決着する経路のふるまいを検査する歯（Issue #107）。**DB は要らない。**
 *
 * ## この歯が測らないもの（他の歯に譲る）
 *
 * - 引数・環境変数の解釈そのもの（`--schema` > `MNEMORA_SCHEMA` > 未指定 の優先順位、
 *   未知オプションの弾き方等）は `parseMigrateCliOptions` の純関数テストとして
 *   `./cli-options.test.ts` に20件ある。**ここで同じことをもう一度測らない**
 *   （`../bin/cli-options.ts` の doc コメント参照）。
 * - 指定したスキーマへ実際にマイグレーションが当たるかは DB が要る
 *   （`./migrate-cli-schema.postgres.test.ts` が本物の PostgreSQL に対して測る）。
 *
 * ここで測るのは「CLI を実際に起動したとき、DB に接続する前に決着するパス
 * （`--help` / DATABASE_URL 欠如 / 引数解釈エラー）が、期待どおりの終了コードと
 * 出力で終わるか」——`../bin/migrate.ts` の `main()` の分岐順序
 * （`parseMigrateCliOptions` → `DATABASE_URL` の有無 → 接続）を、プロセスの外から
 * 実測する。`schema-namespace.test.ts` が「DB 無しの歯」の先例（同ファイル冒頭の doc
 * コメント参照）。
 *
 * ## env は明示的に組み立てる
 *
 * `execFile` に渡す `env` は `process.env` をそのまま渡さない。実行環境に
 * `DATABASE_URL` / `MNEMORA_SCHEMA` / `MNEMORA_EXTENSION_SCHEMA` が設定されているか
 * どうかで各テストが測ろうとしている経路がずれてしまうため、必要な変数だけを
 * 明示的に組み立てる（`buildEnv` 参照）。
 */

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
const MIGRATE_ENTRY = path.join("src", "bin", "migrate.ts");

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `env` は「渡したいものだけ」を書く。`PATH` は `tsx` の shebang（`#!/usr/bin/env node`）を
 * 解決するのに必須なので常に含める。それ以外（`DATABASE_URL` / `MNEMORA_SCHEMA` /
 * `MNEMORA_EXTENSION_SCHEMA`）はこの関数の引数で渡さない限り、この子プロセスの
 * 環境には一切存在しない——実行環境の値を継承しない。
 */
function buildEnv(overrides: Readonly<Record<string, string>>): Record<string, string> {
  return { PATH: process.env.PATH ?? "", ...overrides };
}

async function runCli(
  args: readonly string[],
  overrides: Readonly<Record<string, string>>,
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [MIGRATE_ENTRY, ...args], {
      cwd: PACKAGE_ROOT,
      env: buildEnv(overrides),
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const code = typeof failure.code === "number" ? failure.code : 1;
    return { exitCode: code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("mnemora-postgres-migrate（子プロセス起動、DB 無し）", () => {
  it("--help: 終了コード0で、--schema / --extension-schema / MNEMORA_SCHEMA / 優先順位の説明が出る", async () => {
    const result = await runCli(["--help"], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--schema");
    expect(result.stdout).toContain("--extension-schema");
    expect(result.stdout).toContain("MNEMORA_SCHEMA");
    expect(result.stdout).toContain("MNEMORA_EXTENSION_SCHEMA");
    expect(result.stdout, "優先順位の説明が出ること").toContain(
      "優先順位: コマンドライン引数 > 環境変数 > 未指定。",
    );
  });

  it("DATABASE_URL が無い・引数無し: 終了コード1で、標準エラーに DATABASE_URL が無い旨が出る", async () => {
    const result = await runCli([], {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL");
  });

  it(
    "--extension-schema だけ（--schema 無し・MNEMORA_SCHEMA も無し）: " +
      "DATABASE_URL が設定されていても、接続する前に終了コード1で止まる",
    async () => {
      // 🔴 わざと繋がらない DATABASE_URL を渡す。もしコードが「引数の検査より先に
      // 接続を試みる」実装だったら、この値では接続確立に時間がかかる・失敗するなど
      // 別の壊れ方をするはず。ここで期待どおり素早く exitCode 1 になることが、
      // 「引数の検査が接続より前に在る」という順序そのものの実測になる。
      const result = await runCli(["--extension-schema", "public"], {
        DATABASE_URL: "postgresql://cli-process-test-must-not-connect@127.0.0.1:1/nope",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--schema");
    },
  );

  it("未知の引数（--nope）: 終了コード1", async () => {
    const result = await runCli(["--nope"], {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--nope");
  });
});

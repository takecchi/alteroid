import { describe, expect, it } from "vitest";
import {
  formatMigrateCliUsage,
  parseMigrateCliOptions,
  type MigrateCliParseResult,
} from "../bin/cli-options.js";

/**
 * `mnemora-postgres-migrate` の引数・環境変数解釈（Issue #107）を、**DB 無しで**検査する歯。
 *
 * `parseMigrateCliOptions` は純関数として切り出してある（`../bin/cli-options.ts` の doc
 * コメント参照）ため、ここでは `Pool` も `runMigrations` も一切登場しない。実際に
 * 別スキーマへマイグレーションが当たることの検査は別ファイル（DB を要する歯）の役割で、
 * ここには置かない。
 *
 * ⚠ 実装の形（内部の変数名・エラーメッセージの完全一致）ではなく、**ふるまい**
 * （どの入力がどう解決されるか / どの入力が `ok: false` になるか）を固定する。
 * メッセージの検査は部分一致（`toMatch`）にとどめる。
 */

function expectOk(result: MigrateCliParseResult): asserts result is {
  ok: true;
  options: { help: boolean; schema?: string; extensionSchema?: string };
} {
  expect(result.ok).toBe(true);
}

function expectErr(
  result: MigrateCliParseResult,
): asserts result is { ok: false; error: { message: string } } {
  expect(result.ok).toBe(false);
}

describe("parseMigrateCliOptions: 未指定時の既定", () => {
  it("引数も環境変数も無ければ schema / extensionSchema はどちらも undefined（今日と同じ振る舞い）", () => {
    const result = parseMigrateCliOptions([], {});
    expectOk(result);
    expect(result.options.help).toBe(false);
    expect(result.options.schema).toBeUndefined();
    expect(result.options.extensionSchema).toBeUndefined();
  });
});

describe("parseMigrateCliOptions: 引数のみ", () => {
  it("--schema <name> の空白区切りで指定できる", () => {
    const result = parseMigrateCliOptions(["--schema", "tenant_a"], {});
    expectOk(result);
    expect(result.options.schema).toBe("tenant_a");
  });

  it("--schema=<name> の = 区切りでも指定できる", () => {
    const result = parseMigrateCliOptions(["--schema=tenant_a"], {});
    expectOk(result);
    expect(result.options.schema).toBe("tenant_a");
  });

  it("--extension-schema は --schema と併用すれば指定できる（空白区切り / = 区切り両方）", () => {
    const spaceForm = parseMigrateCliOptions(["--schema", "s", "--extension-schema", "ext"], {});
    expectOk(spaceForm);
    expect(spaceForm.options.schema).toBe("s");
    expect(spaceForm.options.extensionSchema).toBe("ext");

    const eqForm = parseMigrateCliOptions(["--schema=s", "--extension-schema=ext"], {});
    expectOk(eqForm);
    expect(eqForm.options.schema).toBe("s");
    expect(eqForm.options.extensionSchema).toBe("ext");
  });
});

describe("parseMigrateCliOptions: 環境変数のみ", () => {
  it("MNEMORA_SCHEMA / MNEMORA_EXTENSION_SCHEMA を読む", () => {
    const result = parseMigrateCliOptions([], {
      MNEMORA_SCHEMA: "tenant_env",
      MNEMORA_EXTENSION_SCHEMA: "ext_env",
    });
    expectOk(result);
    expect(result.options.schema).toBe("tenant_env");
    expect(result.options.extensionSchema).toBe("ext_env");
  });
});

describe("parseMigrateCliOptions: 優先順位（引数 > 環境変数）", () => {
  it("--schema と MNEMORA_SCHEMA が両方あれば引数が勝つ", () => {
    const result = parseMigrateCliOptions(["--schema", "from_arg"], {
      MNEMORA_SCHEMA: "from_env",
    });
    expectOk(result);
    expect(result.options.schema).toBe("from_arg");
  });

  it("--extension-schema と MNEMORA_EXTENSION_SCHEMA が両方あれば引数が勝つ", () => {
    const result = parseMigrateCliOptions(["--schema", "s", "--extension-schema", "from_arg"], {
      MNEMORA_SCHEMA: "s",
      MNEMORA_EXTENSION_SCHEMA: "from_env",
    });
    expectOk(result);
    expect(result.options.extensionSchema).toBe("from_arg");
  });

  it("schema は環境変数、extensionSchema は引数、という組み合わせも解決できる", () => {
    const result = parseMigrateCliOptions(["--extension-schema", "ext_arg"], {
      MNEMORA_SCHEMA: "schema_env",
    });
    expectOk(result);
    expect(result.options.schema).toBe("schema_env");
    expect(result.options.extensionSchema).toBe("ext_arg");
  });
});

describe("parseMigrateCliOptions: --extension-schema 単独（schema 側が最終的に無指定）", () => {
  it("引数だけで --extension-schema を指定し --schema も MNEMORA_SCHEMA も無ければエラー", () => {
    const result = parseMigrateCliOptions(["--extension-schema", "ext"], {});
    expectErr(result);
    expect(result.error.message).toMatch(/schema/i);
  });

  it("MNEMORA_EXTENSION_SCHEMA だけを設定し schema 側が無指定でもエラー", () => {
    const result = parseMigrateCliOptions([], { MNEMORA_EXTENSION_SCHEMA: "ext" });
    expectErr(result);
    expect(result.error.message).toMatch(/schema/i);
  });
});

describe("parseMigrateCliOptions: 不正なスキーマ名", () => {
  it("assertSafeSchemaName が落とす名前（大文字を含む）はエラーになる", () => {
    const result = parseMigrateCliOptions(["--schema", "Tenant"], {});
    expectErr(result);
    expect(result.error.message).toMatch(/unsafe/i);
  });

  it("環境変数経由の不正な名前も同じくエラーになる", () => {
    const result = parseMigrateCliOptions([], { MNEMORA_SCHEMA: "tenant-a" });
    expectErr(result);
    expect(result.error.message).toMatch(/unsafe/i);
  });

  it("extensionSchema 側の不正な名前もエラーになる", () => {
    const result = parseMigrateCliOptions(["--schema", "s", "--extension-schema", "1bad"], {});
    expectErr(result);
    expect(result.error.message).toMatch(/unsafe/i);
  });
});

describe("parseMigrateCliOptions: 未知の引数・値の欠けた引数", () => {
  it("未知のオプションはエラーになる", () => {
    const result = parseMigrateCliOptions(["--foo"], {});
    expectErr(result);
  });

  it("--schema の値が無い（末尾）とエラーになる", () => {
    const result = parseMigrateCliOptions(["--schema"], {});
    expectErr(result);
  });

  it("--schema の次のトークンが -- で始まる場合も値が無いものとしてエラーになる", () => {
    const result = parseMigrateCliOptions(["--schema", "--extension-schema", "ext"], {});
    expectErr(result);
  });
});

describe("parseMigrateCliOptions: --help", () => {
  it("--help があれば help: true を返し、schema 等は解決しない", () => {
    const result = parseMigrateCliOptions(["--help"], { MNEMORA_SCHEMA: "should-be-ignored" });
    expectOk(result);
    expect(result.options.help).toBe(true);
  });

  it("-h も同じ効果を持つ", () => {
    const result = parseMigrateCliOptions(["-h"], {});
    expectOk(result);
    expect(result.options.help).toBe(true);
  });

  it("不正な --schema と --help が同時にあっても help を優先する（表示に徹する）", () => {
    const result = parseMigrateCliOptions(["--schema", "Tenant", "--help"], {});
    expectOk(result);
    expect(result.options.help).toBe(true);
  });
});

describe("formatMigrateCliUsage", () => {
  it("使い方・引数・環境変数・優先順位に触れている", () => {
    const usage = formatMigrateCliUsage();
    expect(usage).toMatch(/--schema/);
    expect(usage).toMatch(/--extension-schema/);
    expect(usage).toMatch(/MNEMORA_SCHEMA/);
    expect(usage).toMatch(/MNEMORA_EXTENSION_SCHEMA/);
    expect(usage).toMatch(/優先/);
  });
});

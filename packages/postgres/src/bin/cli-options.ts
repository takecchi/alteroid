import { assertSafeSchemaName } from "../schema-namespace.js";

/**
 * `mnemora-postgres-migrate`（`./migrate.ts`）のコマンドライン引数・環境変数を解釈する
 * 純関数（Issue #107）。
 *
 * ## 背景
 *
 * 専用スキーマ対応（`SchemaNamespaceOptions` = `schema` / `extensionSchema`）はライブラリ側
 * （`../migrate.ts` の `runMigrations`）に既に入っているが、CLI からはこれまで一切渡す
 * 手段が無く、`main()` は常に `runMigrations(pool)` を呼んでいた。共有 DB に他システム
 * （Prisma 管理の `public` 等）が同居する導入先が、mnemora のテーブル群を別スキーマへ
 * 隔離できない、という実報告に対応する。**これは既に決まっている方針の取りこぼしの
 * 解消であり、新しい設計判断ではない。**
 *
 * ## なぜ別モジュールに切り出すか
 *
 * 引数解釈を `bin/migrate.ts` に書き込むと、DB 接続（`Pool`）を経由しないと歯を
 * 通せない。ここでは `Pool` は一切登場しない純関数として切り出し、DB 無しで
 * 分岐を検査できるようにする（`../__tests__/cli-options.test.ts`）。
 *
 * ## 優先順位: コマンドライン引数 > 環境変数 > 未指定
 *
 * `--schema` / `--extension-schema` が指定されていれば、対応する環境変数
 * （`MNEMORA_SCHEMA` / `MNEMORA_EXTENSION_SCHEMA`）より常に優先する。両方とも
 * 指定が無ければ `undefined` のままで、`runMigrations(pool)`（options 省略）と
 * **1バイトも変わらない**振る舞いになる——`../schema-namespace.ts` の doc が
 * 「`schema` を指定しない既定の経路は今日と1バイトも変わらないこと」を最優先の線として
 * 引いており、CLI 側もこれを崩さない。
 *
 * ## `--extension-schema` だけを指定した場合（`--schema` 無し）
 *
 * `../schema-namespace.ts` の `SchemaNamespaceOptions.extensionSchema` の doc が
 * 「`extensionSchema` は `schema` を指定したときだけ効く」と明言している。CLI がこれを
 * 黙って無視すると、利用者は「拡張の置き場所を専用スキーマにした」つもりで実際には
 * 何も変わらない（`public` のまま）——気付かれにくい事故になる。**したがって
 * `--schema`（および `MNEMORA_SCHEMA`）が最終的に無指定なのに `--extension-schema`
 * （または `MNEMORA_EXTENSION_SCHEMA`）だけが指定されている場合はエラーとし、
 * 終了コード 1 で止める。** 黙って無視する・`schema` も暗黙に何か決める、のどちらも
 * 採らない。
 *
 * ## スキーマ名の検査
 *
 * `../schema-namespace.ts` の `assertSafeSchemaName` を呼ぶ（正規表現を書き写さない）。
 * このリポジトリは同じ検査ロジックの複製を明示的に嫌っている
 * （`assertSafeSchemaName` の doc コメント参照）。
 */

/** `parseMigrateCliOptions` が返す、解釈済みのオプション。 */
export interface ParsedMigrateCliOptions {
  /** `--help` / `-h` が指定されていた場合 `true`。true のときは他の値を見なくてよい。 */
  help: boolean;
  /**
   * 適用先スキーマ。`--schema` > `MNEMORA_SCHEMA` > 未指定（`undefined`）の優先順位で
   * 解決する。`undefined` は「今日と同じ振る舞い」（`runMigrations(pool)` 相当）を表す。
   */
  schema?: string;
  /**
   * 拡張の置き場所。`--extension-schema` > `MNEMORA_EXTENSION_SCHEMA` > 未指定の優先順位。
   * `schema` が未指定のまま値を持つことは無い（そのケースはエラーとして弾く）。
   */
  extensionSchema?: string;
}

/** 解釈に失敗したことを表す。`message` はそのまま `console.error` に渡せる説明文。 */
export interface MigrateCliParseError {
  message: string;
}

export type MigrateCliParseResult =
  { ok: true; options: ParsedMigrateCliOptions } | { ok: false; error: MigrateCliParseError };

const SCHEMA_FLAG = "--schema";
const EXTENSION_SCHEMA_FLAG = "--extension-schema";

/**
 * `argv`（`process.argv.slice(2)` を渡す想定。`node` 本体・スクリプトパスは含めない）と
 * `env`（`process.env` を渡す想定）から、CLI が必要とするオプションを解決する。
 *
 * 受け付ける形:
 * - `--schema <name>` / `--schema=<name>`
 * - `--extension-schema <name>` / `--extension-schema=<name>`
 * - `--help` / `-h`
 *
 * 弾く形（`ok: false` を返す）:
 * - 未知のオプション（例: `--foo`）
 * - 値が無い `--schema`（末尾で値が無い、または次のトークンが `--` で始まる）
 * - `assertSafeSchemaName` が落とす名前
 * - `--schema`（`MNEMORA_SCHEMA` も含め）を伴わない `--extension-schema`
 *   （`MNEMORA_EXTENSION_SCHEMA` も含め）
 */
export function parseMigrateCliOptions(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): MigrateCliParseResult {
  let schemaArg: string | undefined;
  let extensionSchemaArg: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    const eqIndex = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);

    if (flag !== SCHEMA_FLAG && flag !== EXTENSION_SCHEMA_FLAG) {
      return { ok: false, error: { message: `unknown option: ${arg}` } };
    }

    let value: string;
    if (eqIndex !== -1) {
      value = arg.slice(eqIndex + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, error: { message: `option ${flag} requires a value` } };
      }
      value = next;
      i += 1;
    }

    if (flag === SCHEMA_FLAG) {
      schemaArg = value;
    } else {
      extensionSchemaArg = value;
    }
  }

  // --help はどんな組み合わせでも他の解釈をせず即座に返す（ヘルプ表示に徹する）。
  if (help) {
    return { ok: true, options: { help: true } };
  }

  const schema = schemaArg ?? env.MNEMORA_SCHEMA;
  const extensionSchema = extensionSchemaArg ?? env.MNEMORA_EXTENSION_SCHEMA;

  if (schema === undefined && extensionSchema !== undefined) {
    return {
      ok: false,
      error: {
        message:
          "--extension-schema (MNEMORA_EXTENSION_SCHEMA) を指定するには --schema " +
          "(MNEMORA_SCHEMA) も必要です。extensionSchema は schema を指定したときだけ効くため、" +
          "schema 無しの指定はエラーにしています。",
      },
    };
  }

  try {
    if (schema !== undefined) {
      assertSafeSchemaName(schema);
    }
    if (extensionSchema !== undefined) {
      assertSafeSchemaName(extensionSchema);
    }
  } catch (err) {
    return { ok: false, error: { message: (err as Error).message } };
  }

  return { ok: true, options: { help: false, schema, extensionSchema } };
}

/**
 * `--help` / `-h` のときに表示する使い方。使い方・引数・環境変数・優先順位を
 * 一箇所にまとめる（README と内容が重複するが、`--help` はネットワーク越しに
 * README を読めない状況でも使えることに意味があるため、意図的に持たせてある）。
 */
export function formatMigrateCliUsage(): string {
  return `使い方: mnemora-postgres-migrate [--schema <name>] [--extension-schema <name>]

保留中の migrations/*.sql をファイル名の昇順で適用する。DATABASE_URL は必須（環境変数）。

オプション:
  --schema <name>            mnemora のテーブル・索引・マイグレーション台帳を置く
                              専用スキーマ。--schema=<name> の = 区切りでも指定できる。
                              省略時は接続の search_path 任せ（今日どおりの振る舞い）。
  --extension-schema <name>  vector / btree_gin / pgcrypto を置くスキーマ。
                              --schema を指定したときだけ効く（--schema 無しで
                              これだけ指定するとエラーになる）。省略時は "public"。
  -h, --help                  このヘルプを表示して終了する（終了コード 0）。

環境変数:
  MNEMORA_SCHEMA              --schema の環境変数版。
  MNEMORA_EXTENSION_SCHEMA     --extension-schema の環境変数版。

優先順位: コマンドライン引数 > 環境変数 > 未指定。
どちらも指定しなければ、今日と1バイトも変わらない振る舞いになる。
`;
}

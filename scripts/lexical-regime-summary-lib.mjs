/**
 * `scripts/lexical-regime-summary.mjs`(CI の Job Summary に載せる Markdown を組み立てる
 * CLI)の純関数の側。ファイル I/O・`process.argv`・`process.exit` を一切持たない
 * ——`consolidation-cost-summary-lib.mjs`/`identifier-probe-summary-lib.mjs` と同じ分担・
 * 同じ理由(Issue #148)。
 *
 * `packages/postgres/src/__tests__/lexical-store-identifier.test.ts` の
 * 「素の to_tsvector で識別子を引けるかどうかは server_encoding で反転する」の歯が
 * `MNEMORA_LEXICAL_REGIME_JSON` へ書く JSON(`LexicalRegimeJson`、TS 側にしか型が無い
 * ——二重管理であることを認めて mjs 側は素の JSON として扱う)を Markdown へ変換する。
 *
 * ## ⛔ これは門ではない。基準値ファイルも置かない
 *
 * `consolidation-cost-summary.mjs` 等の既存3組は基準値ファイルと diff を取るが、
 * **この script は基準値と比べない**——`server_encoding` がどちらであっても、
 * `nonAsciiIsIndexed` が `true` でも `false` でも、常に exit 0 である。
 *
 * 🔴 **なぜ基準値ファイルを置かないか(意図的な非対称)**: Issue #148 が対象にする
 * regime(`server_encoding`)は、mnemora が SQL_ASCII/LATIN1 をサポート対象にするかを
 * **オーナーがまだ決めていない**前提の上に乗っている(`docs/roadmap.md` の
 * 「設計上まだ判断が必要な点」)。ここで基準値ファイルを置いて「一致/相違」を語り始めると、
 * **その基準値自体が「サポートする regime はこれだ」という実装からの先回りの答えになる**
 * ——決めていない前提を、可視化の実装が代わりに決めてしまう。だから基準値は置かない。
 * この script が Job Summary に出すのは「今回の実測はこれだった」という申告だけであり、
 * 良し悪しの判定を1つも含まない。
 *
 * ## 🔴 「値が出ていない」と「値が空だった」を区別する
 *
 * この script が非0で終わる経路は3つあり、**意図して別々のメッセージにしている**
 * (`scripts/lexical-regime-summary.mjs` 側の分担):
 *
 * 1. **ファイルが無い**(`ENOENT`) — 「値が出ていない」。歯(`lexical-store-identifier.
 *    test.ts`)が `MNEMORA_LEXICAL_REGIME_JSON` への書き込みをそもそも呼んでいない
 *    可能性がある——測定段自体が落ちていないか先に見ること、という趣旨。
 * 2. **JSON の parse に失敗する** — ファイルはあるが壊れている(書き込みが途中で
 *    切れた、等)。
 * 3. **この lib の `validateMeasured` が拒否する**(鍵が欠けている・値が空文字・
 *    `serverVersion`/`serverEncoding` が空、等) — 「値が空だった」。ファイルも
 *    JSON としては存在するが、中身が使い物にならない。
 *
 * ⟹ **これは「値の門」ではなく「可視化そのものが壊れたことの門」である。**
 * regime の値そのもの(UTF8 か SQL_ASCII か、`nonAsciiIsIndexed` が true か false か)は
 * 一切門にしない——上の3つのどの経路も、regime の値を一切参照しない。
 */

const REQUIRED_STRING_FIELDS = ["serverVersion", "serverEncoding", "rawTsvector", "regime"];
const REQUIRED_BOOLEAN_FIELDS = ["nonAsciiIsIndexed", "rawIdentifierHit", "rawJapaneseWordHit"];

function isObject(value) {
  return typeof value === "object" && value !== null;
}

/**
 * `MNEMORA_LEXICAL_REGIME_JSON` が吐いた JSON(パース済み)の形を検査する。
 *
 * ⚠ **ここでは regime の値そのものの良し悪しを一切判定しない**(門にしないため)。
 * 検査するのは「値が空・欠けていないか」という構造だけである。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (!isObject(data)) {
    return { ok: false, error: "regime JSON がオブジェクトでない" };
  }
  const problems = [];
  if (typeof data.schemaVersion !== "number") {
    problems.push("schemaVersion が数値でない");
  }
  if (typeof data.measuredAt !== "string" || data.measuredAt === "") {
    problems.push("measuredAt が文字列でない、または空");
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof data[field] !== "string" || data[field] === "") {
      problems.push(`${field} が文字列でない、または空`);
    }
  }
  for (const field of REQUIRED_BOOLEAN_FIELDS) {
    if (typeof data[field] !== "boolean") {
      problems.push(`${field} が真偽値でない`);
    }
  }
  if (problems.length > 0) {
    return {
      ok: false,
      error: `regime JSON の値が空だった、または壊れている: ${problems.join("; ")}`,
    };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

/**
 * Markdown を組み立てる。`validateMeasured` を通した値を渡すこと。
 *
 * 🔴 **良し悪しを1つも含まない。**`server_encoding`/`nonAsciiIsIndexed` がどちらでも、
 * 同じ形の申告を出すだけである(Issue #148 の受け入れ基準「⛔ 門にしない」)。
 *
 * @param {Record<string, any>} measured
 */
export function buildSummaryMarkdown(measured) {
  const regimeLabel =
    measured.regime === "non_ascii_indexed"
      ? "non_ascii_indexed(非ASCIIが語として残る側)"
      : measured.regime === "non_ascii_dropped"
        ? "non_ascii_dropped(非ASCIIが丸ごと落ちる側)"
        : `${measured.regime}(未知の値——歯側の分岐が増えた可能性がある)`;

  return [
    "# lexical の server_encoding regime の実測(Issue #148)",
    "",
    "⛔ **これは門ではない。**下の値がどちらであっても、このステップは exit 0 である" +
      "——mnemora が SQL_ASCII/LATIN1 をサポート対象にするかは、まだオーナーが決めていない" +
      "前提であり(`docs/roadmap.md`)、この可視化の実装が先回りして答えを出さない。",
    "",
    "| 項目 | 値 |",
    "|---|---|",
    `| server_version | ${measured.serverVersion} |`,
    `| server_encoding | ${measured.serverEncoding} |`,
    `| nonAsciiIsIndexed | ${measured.nonAsciiIsIndexed} |`,
    `| regime | ${regimeLabel} |`,
    `| rawIdentifierHit(素の tsvector で識別子が引けるか) | ${measured.rawIdentifierHit} |`,
    `| rawJapaneseWordHit(素の tsvector で日本語の語が引けるか) | ${measured.rawJapaneseWordHit} |`,
    `| measuredAt | ${measured.measuredAt} |`,
    "",
    "生の tsvector(参考。長いことがある):",
    "",
    "```",
    String(measured.rawTsvector),
    "```",
    "",
    "⚠ この値の読み方は " +
      "[ADR 0103](https://github.com/takecchi/mnemora/blob/main/docs/decisions/" +
      "0103-negative-tooth-declares-its-precondition.md) と " +
      "[Issue #145](https://github.com/takecchi/mnemora/issues/145) を見ること" +
      "——`server_encoding` によって「素の to_tsvector で識別子を引けるか」の結論そのものが" +
      "反転する(反転しても `mnemora_lexical_normalize` を通した本番経路の結論は変わらない)。",
  ].join("\n");
}

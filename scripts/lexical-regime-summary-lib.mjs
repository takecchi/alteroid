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
 * 🔴 **なぜ基準値ファイルを置かないか**: `server_encoding` がどちらであっても、
 * この script が Job Summary に出すのは「今回の実測はこれだった」という申告だけであり、
 * 良し悪しの判定を1つも含まない。
 *
 * ⚠ **2026-09-12 訂正**: 以前はここに「Issue #148 が対象にする regime
 * (`server_encoding`)は、mnemora が SQL_ASCII/LATIN1 をサポート対象にするかを
 * **オーナーがまだ決めていない**前提の上に乗っている(`docs/roadmap.md` の
 * 「設計上まだ判断が必要な点」)。ここで基準値ファイルを置いて『一致/相違』を語り始めると、
 * その基準値自体が『サポートする regime はこれだ』という実装からの先回りの答えになる」
 * と書いていたが、これはもう事実ではない。**オーナー(takecchi)は 2026-09-12T00:09Z に、
 * `server_encoding` が `SQL_ASCII` の PostgreSQL をサポート対象にすると決めた**
 * ([ADR 0106](../docs/decisions/0106-ci-declares-the-regime-it-measures.md))。
 * ⛔ `LATIN1` はまだ別途確認中で未回答であり、この決定には含まれていない。
 *
 * ⟹ **基準値ファイルを置かない理由も変わった**: 「決まっていないから」ではなく、
 * **基準値はもう `.github/workflows/ci.yml` の `POSTGRES_INITDB_ARGS`
 * (`--encoding=UTF8`)に在り**、下の `--expect-encoding` がそれを受け取っている
 * からである。別のファイルに二重に基準値を置く必要が無い。
 *
 * ⛔ **これは「だから門にする」という意味ではない。**この script はいまも
 * 値の良し悪しを一切門にしない。**むしろオーナーが `SQL_ASCII` をサポート対象に
 * すると決めたからこそ、`SQL_ASCII` を『悪い値』として門にすることはできない**
 * ——この script が門にするのは `ci.yml` が宣言した regime と実際に測れた regime が
 * 食い違ったことだけであり、それは「どの regime をサポートするか」という製品判断を
 * 1つも含まない。
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
 *
 * ## 🔴 Issue #148 ②: 新しく門にしたのは「宣言と実測の食い違い」だけ
 *
 * `.github/workflows/ci.yml` は6本の pgvector ジョブすべてに
 * `POSTGRES_INITDB_ARGS: "--encoding=UTF8"` を足し、**自分がどの regime で測っている
 * つもりか**を宣言し始めた。`compareDeclaredEncoding` はその宣言値と、この歯が実測した
 * `serverEncoding` を突き合わせる、**第4の非0経路**を足す。
 *
 * ⟹ **だからこの script は、依然として値の良し悪しを一切門にしない。**
 * `server_encoding` が `UTF8` であることも `SQL_ASCII` であることも、それ自体では
 * 非0にならない——**「UTF8 が正しい」「SQL_ASCII が悪い」とはどこにも書かない。**
 * 非0になるのは「ci.yml がこうだと宣言した値」と「実際に測れた値」が**一致しなかった**
 * ときだけであり、これは上の3経路と同じ性質の門(可視化・宣言が壊れたことの門)である。
 *
 * ⚠ **2026-09-12 訂正**: 以前はここに「mnemora が SQL_ASCII/LATIN1 をサポート対象に
 * するかを**オーナーがまだ決めていない**という前提(`docs/roadmap.md` の「設計上まだ
 * 判断が必要な点」)には、この4つ目の門も一切踏み込まない」と書いていたが、SQL_ASCII に
 * ついてはもう事実ではない——オーナーは 2026-09-12T00:09Z にサポート対象にすると決めた
 * ([ADR 0106](../docs/decisions/0106-ci-declares-the-regime-it-measures.md))。
 * **それでも、この4つ目の門はサポート対象の判断へ一切踏み込まない**——むしろ
 * `SQL_ASCII` がサポート対象になった今こそ、それを「悪い値」として門にしてはならない。
 * (`LATIN1` は未回答であり、この決定の対象外のままである。)
 */

const REQUIRED_STRING_FIELDS = [
  "serverVersion",
  "serverEncoding",
  "rawTsvector",
  "regime",
  "lcCollate",
  "lcCtype",
  "defaultTextSearchConfig",
];
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
 * `.github/workflows/ci.yml` が宣言した encoding(`POSTGRES_INITDB_ARGS` から取り出した
 * `--expect-encoding` の値)と、この歯が実測した `serverEncoding` を突き合わせる(Issue #148 ②)。
 *
 * 🔴 **`error` は「赤の意味」を書く**:
 *
 * 1. **実装のバグではない。**赤くなったのは CI の regime が動いたからである
 *    (`mnemora_lexical_normalize`/`PostgresLexicalStore` 側を疑わないこと)。
 * 2. 疑うのは `.github/workflows/ci.yml` の `POSTGRES_INITDB_ARGS`、または
 *    service image(`pgvector/pgvector:pg17`)の既定が変わったことである。
 * 3. 宣言値と実測値の**両方**を書く——どちらか片方だけでは一次診断にならない。
 *
 * ⚠ **良し悪しの判定はしない。**`declaredEncoding`/`measured.serverEncoding` が
 * `UTF8` か `SQL_ASCII` かそれ以外かを一切問わない——見るのは「一致したか」だけである。
 *
 * @param {Record<string, any>} measured `validateMeasured` を通した値
 * @param {string} declaredEncoding ci.yml の `POSTGRES_INITDB_ARGS` から取り出した宣言値
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function compareDeclaredEncoding(measured, declaredEncoding) {
  if (measured.serverEncoding === declaredEncoding) {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      "🔴 これは実装のバグではない。赤くなったのは CI の regime が動いたからである" +
      "——疑うのは実装(mnemora_lexical_normalize 等)ではなく、" +
      "`.github/workflows/ci.yml` の `POSTGRES_INITDB_ARGS`、または " +
      "service image(pgvector/pgvector:pg17)の既定が変わったことである。 " +
      `宣言値(--expect-encoding)=${declaredEncoding} / ` +
      `実測値(server_encoding)=${measured.serverEncoding}`,
  };
}

/**
 * Markdown を組み立てる。`validateMeasured` を通した値を渡すこと。
 *
 * 🔴 **良し悪しを1つも含まない。**`server_encoding`/`nonAsciiIsIndexed` がどちらでも、
 * 同じ形の申告を出すだけである(Issue #148 の受け入れ基準「⛔ 門にしない」)。
 * `declaredEncoding` を渡しても、この関数自体は一致/不一致を「良し悪し」として書かない
 * ——「UTF8 が正しい」「SQL_ASCII が悪い」とは書かず、「宣言と実測が一致したか」だけを表に出す
 * (一致/不一致の判定そのものは `compareDeclaredEncoding` の役目であり、この関数は
 * それを呼ばない——呼び出し側(`lexical-regime-summary.mjs`)が組み合わせる)。
 *
 * @param {Record<string, any>} measured
 * @param {string} declaredEncoding ci.yml の `POSTGRES_INITDB_ARGS` から取り出した宣言値
 */
export function buildSummaryMarkdown(measured, declaredEncoding) {
  const regimeLabel =
    measured.regime === "non_ascii_indexed"
      ? "non_ascii_indexed(非ASCIIが語として残る側)"
      : measured.regime === "non_ascii_dropped"
        ? "non_ascii_dropped(非ASCIIが丸ごと落ちる側)"
        : `${measured.regime}(未知の値——歯側の分岐が増えた可能性がある)`;
  const encodingMatch = measured.serverEncoding === declaredEncoding;

  return [
    "# lexical の server_encoding regime の実測(Issue #148)",
    "",
    "⛔ **値の良し悪しは門ではない。**下の server_encoding / nonAsciiIsIndexed が" +
      "どちらであっても、それ自体でこのステップが exit 0 でなくなることはない" +
      "——オーナー(takecchi)は 2026-09-12T00:09Z に、server_encoding が SQL_ASCII の" +
      "PostgreSQL をサポート対象にすると決めた(ADR 0106)。だからこそ SQL_ASCII を" +
      "「悪い値」として門にすることはできない——この可視化が門にするのは規範の判断では" +
      "なく、宣言と実測の一致だけである(LATIN1 は未回答であり、この決定の対象外)。",
    "",
    "🔴 **ただし「宣言と実測の食い違い」は門である(Issue #148 ②)。**" +
      "`.github/workflows/ci.yml` の `POSTGRES_INITDB_ARGS` が宣言した encoding と、" +
      "実際に測れた server_encoding が一致しなかったときだけ、このステップは非0で終わる。",
    "",
    "| 項目 | 値 |",
    "|---|---|",
    `| server_version | ${measured.serverVersion} |`,
    `| server_encoding | ${measured.serverEncoding} |`,
    `| nonAsciiIsIndexed | ${measured.nonAsciiIsIndexed} |`,
    `| regime | ${regimeLabel} |`,
    `| rawIdentifierHit(素の tsvector で識別子が引けるか) | ${measured.rawIdentifierHit} |`,
    `| rawJapaneseWordHit(素の tsvector で日本語の語が引けるか) | ${measured.rawJapaneseWordHit} |`,
    `| lc_collate | ${measured.lcCollate} |`,
    `| lc_ctype | ${measured.lcCtype} |`,
    `| default_text_search_config | ${measured.defaultTextSearchConfig} |`,
    `| 宣言(ci.yml の \`POSTGRES_INITDB_ARGS\`) | ${declaredEncoding} |`,
    `| 宣言と実測(server_encoding)は一致したか | ${encodingMatch} |`,
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
      "0103-negative-tooth-declares-its-precondition.md)、" +
      "[ADR 0106](https://github.com/takecchi/mnemora/blob/main/docs/decisions/" +
      "0106-ci-declares-the-regime-it-measures.md) と " +
      "[Issue #145](https://github.com/takecchi/mnemora/issues/145) を見ること" +
      "——`server_encoding` によって「素の to_tsvector で識別子を引けるか」の結論そのものが" +
      "反転する(反転しても `mnemora_lexical_normalize` を通した本番経路の結論は変わらない)。",
  ].join("\n");
}

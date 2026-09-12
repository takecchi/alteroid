/**
 * `postgres` ジョブを matrix にしたあと、**両方の regime(server_encoding)が実際に走った
 * ことを測る**純関数の側(Issue #155 満たすべきこと2)。
 *
 * `.github/workflows/ci.yml` の `postgres` ジョブは `strategy.matrix.include` で
 * `UTF8` / `SQL_ASCII` の2脚に分かれ、各脚が `lexical-regime-${{ matrix.serverEncoding }}`
 * という名前の artifact を(`if: always()`・`if-no-files-found: ignore` で)アップロードする。
 *
 * ⛔ **`postgres` ジョブが緑であることは「両方が走った」ことを意味しない。**
 * - 片方の脚が container の起動ごと落ちて `test:db` へすら到達しなければ、
 *   その脚の artifact は存在しない(`if-no-files-found: ignore` は「無ければ黙る」)。
 * - `fail-fast: false` を付けているので、SQL_ASCII 脚が落ちても UTF8 脚は続く——
 *   だが matrix 全体の `needs.<job>.result` は「どれか1脚でも failure なら failure」
 *   になる。**skip されている(0脚も走っていない)場合と区別する必要がある**——
 *   それは呼び出し側(ci.yml の `postgres-regime-coverage` ジョブ)が
 *   `needs.postgres.result !== "skipped"` を先に見て行う。
 *
 * このモジュールが引き受けるのは、その先——**「artifact が両方揃っていて、
 * 揃った中身が実際に別々の server_encoding を測っているか」**の判定である。
 *
 * ⚠ **`EXPECTED_SERVER_ENCODINGS` は ci.yml の matrix の脚と二重管理である。**
 * ずれたら `scripts/__tests__/ci-yml-postgres-regime-coverage-wiring.test.mjs` の
 * 「lib の期待集合と ci.yml の matrix の脚が一致する」歯が赤くなる
 * (`ci-yml-postgres-regime-wiring.test.mjs` の (c) と同じ思想——二重管理の腐りを歯で検出する)。
 */

/**
 * この PR の時点でオーナーがサポート対象と決めた regime の集合(Issue #155)。
 * `LATIN1` はオーナーへ別途確認中で未回答のため、ここに含めない。
 *
 * @type {readonly string[]}
 */
export const EXPECTED_SERVER_ENCODINGS = ["UTF8", "SQL_ASCII"];

/**
 * ある server_encoding の脚が upload する artifact の名前。
 * ci.yml 側は `lexical-regime-${{ matrix.serverEncoding }}` と書いており、
 * これは同じ組み立てをスクリプト側で再現したものである(書き写しではなく、
 * 命名規則そのものの再現)。
 *
 * @param {string} serverEncoding
 * @returns {string}
 */
export function artifactNameForEncoding(serverEncoding) {
  return `lexical-regime-${serverEncoding}`;
}

/**
 * @typedef {object} LegStatus
 * @property {string} encoding 期待した server_encoding(`EXPECTED_SERVER_ENCODINGS` の要素)
 * @property {boolean} present artifact のディレクトリ/ファイルが存在したか
 * @property {string} [error] JSON が読めなかった/parse できなかったときの理由
 * @property {string} [measuredEncoding] 実際に JSON が持っていた `serverEncoding` の値
 */

/**
 * 「両方の regime が実際に走ったか」を判定する。
 *
 * 🔴 **3種類の壊れ方を区別する**(いずれも非0にする——値の良し悪しは判定しない):
 * 1. **artifact が無い** — その脚が走らなかった、または測定段が落ちて
 *    JSON を書く前に終わった。
 * 2. **JSON が読めない/parse できない** — artifact はあるが中身が壊れている。
 * 3. **中身の `serverEncoding` が、artifact 名が主張する脚と食い違う** —
 *    artifact 名の付け間違い、または別の脚の JSON を取り違えてアップロードした。
 *
 * 🔴 **さらに、上の3つが全部無くても「実際に測れた server_encoding が2種類ある」ことを
 * 見る。**——たとえ両方の artifact が存在し、名前どおりの脚に見えても、
 * `POSTGRES_INITDB_ARGS` が効いていなければ両方とも同じ値(例: 両方 UTF8)を
 * 測ってしまいうる。これは「artifact が両方ある」だけでは検出できない
 * (Issue #155 ②/ADR 0106 負債4の核心)。
 *
 * ⭐ **弾いていないことの固定**: 期待した2脚がどちらも揃っていて、かつ異なる
 * server_encoding を測っていれば `{ ok: true }` を返す——3脚目や、期待していない
 * 追加の一致を要求しない。
 *
 * @param {LegStatus[]} legs
 * @returns {{ ok: true, distinctMeasured: string[] } | { ok: false, problems: string[] }}
 */
export function evaluateCoverage(legs) {
  /** @type {string[]} */
  const problems = [];

  for (const leg of legs) {
    if (!leg.present) {
      problems.push(
        `${artifactNameForEncoding(leg.encoding)} の artifact が無い` +
          `(server_encoding=${leg.encoding} の脚が走っていないか、artifact を書く前に` +
          "測定段が落ちた可能性がある)",
      );
      continue;
    }
    if (leg.error) {
      problems.push(`${artifactNameForEncoding(leg.encoding)} の中身を読めない: ${leg.error}`);
      continue;
    }
    if (leg.measuredEncoding !== leg.encoding) {
      problems.push(
        `${artifactNameForEncoding(leg.encoding)} の中身が server_encoding=` +
          `${leg.measuredEncoding} を測っている(artifact 名が主張する脚は ${leg.encoding})`,
      );
    }
  }

  const distinctMeasured = [
    ...new Set(
      legs
        .filter((leg) => leg.present && !leg.error && leg.measuredEncoding !== undefined)
        .map((leg) => /** @type {string} */ (leg.measuredEncoding)),
    ),
  ];

  if (problems.length === 0 && distinctMeasured.length < EXPECTED_SERVER_ENCODINGS.length) {
    problems.push(
      `実際に測れた server_encoding が ${distinctMeasured.length} 種類しかない` +
        `(${JSON.stringify(distinctMeasured)})。期待する ${EXPECTED_SERVER_ENCODINGS.length} 種類` +
        `(${JSON.stringify(EXPECTED_SERVER_ENCODINGS)})が別々に走った証拠にならない` +
        "——POSTGRES_INITDB_ARGS が効いていない可能性がある(ADR 0106 負債4)。",
    );
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true, distinctMeasured };
}

/**
 * Job Summary に載せる Markdown を組み立てる。
 *
 * @param {LegStatus[]} legs
 * @param {ReturnType<typeof evaluateCoverage>} result
 * @returns {string}
 */
export function buildCoverageSummaryMarkdown(legs, result) {
  const rows = legs.map((leg) => {
    const status = !leg.present
      ? "artifact 無し"
      : leg.error
        ? `読めない(${leg.error})`
        : leg.measuredEncoding === leg.encoding
          ? `OK(server_encoding=${leg.measuredEncoding})`
          : `不一致(server_encoding=${leg.measuredEncoding})`;
    return `| ${artifactNameForEncoding(leg.encoding)} | ${status} |`;
  });

  const lines = [
    "# 両方の server_encoding regime が実際に走ったか(Issue #155)",
    "",
    "⛔ **`postgres` ジョブが緑であることは、両方の regime が走った証拠ではない。**" +
      "このジョブは matrix の各脚が残した artifact を集め、名前どおりの server_encoding を" +
      "実際に測っていて、かつ2種類とも別の値であることを確かめる。",
    "",
    "| artifact | 状態 |",
    "|---|---|",
    ...rows,
    "",
    result.ok
      ? `✅ 実際に測れた server_encoding: ${JSON.stringify(result.distinctMeasured)}`
      : "🔴 " + result.problems.join(" / "),
  ];
  return lines.join("\n");
}

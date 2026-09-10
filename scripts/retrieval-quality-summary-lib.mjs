/**
 * `scripts/retrieval-quality-summary.mjs`(CI の Job Summary に載せる Markdown を組み立てる
 * CLI)の**純関数の側**。ファイル I/O・`process.argv`・`process.exit` を一切持たない
 * ——`scripts/publish-dry-run.mjs`(判定)と `scripts/decide-publish-dry-run.mjs`
 * (CLI)の分担と同じ形にしてある。理由も同じ: 純関数だけを直接 import して検査できると、
 * 「本物のスクリプトを子プロセスで起動する歯」(`retrieval-quality-summary.test.mjs`)と
 * 「組み立てのロジックだけを見る歯」(`retrieval-quality-summary-lib.test.mjs`)を
 * 分けて置ける。
 *
 * ## なぜこのファイルが要るか
 *
 * `examples/chat` の `retrieval` ベンチ(`MNEMORA_RETRIEVAL_JSON`)が吐く JSON は、
 * 3 arm の MRR/`hit@1`/`hit@10` を持つが、**それを人が読む形(CI の Job Summary)へ
 * 変換する道具がここまで無かった**——ADR 0022 が名指しした「CI に想起の質の回帰を
 * 検知する歯が無い」という負債の、器の側。
 *
 * ## 採らなかった案
 *
 * - **YAML/JSON パーサ以外の依存を足す**(表組みライブラリ等)。却下——
 *   `docs/autonomy.md` は依存追加をオーナー専権と定めている。Markdown のテーブルは
 *   文字列の連結で足りる。
 * - **基準値との相違で non-zero を返す**。却下(呼び出し契約で明示されている)——
 *   このスクリプトは「門」ではない。**bench の値は decay/freshness/tenantId が
 *   実行間で揺れることが分かっている**(ADR 0081 §1・§2)ため、相違そのものは
 *   異常ではない。異常なのは**入力が壊れていること**(JSON が読めない・arm が欠ける・
 *   必須項目が無い)だけであり、それだけを non-zero にする。
 * - **数値の一致を許容誤差付きで比較する**。今回は採らない——`mrrOverall` 等は
 *   `goldRank`(整数)から導かれる有理数であり、**観測した範囲では2回の実行で完全に
 *   一致した**(ADR 0088 §2 の実測)。許容誤差を入れると、コードが変わって本当に値が
 *   動いたときに小さすぎる変化を「一致」として握り潰す恐れがある。
 *   **⚠ ただし「2回一致した」は「決定的である」の証明ではない。**`decay`/`freshness` は
 *   時刻に依存して実行ごとに揺れており(ADR 0088 §2 で `total` の6桁目が動くことを実測)、
 *   `similarity` が約 10^6 倍の変域で押し切っているために順位が動かないだけである。
 *   **⟹ だからこのスクリプトは相違を報告するだけで、門にはしない。**
 *   **もし将来 誤差が必要になったら、その根拠(揺れの実測)を先に取ってから閾値を入れること。**
 */

/** 1 arm が持つべき必須項目と、その型検査。 */
const REQUIRED_ARM_STRING_FIELDS = ["armLabel", "llmMode", "embeddingMode"];
const REQUIRED_ARM_NUMBER_FIELDS = [
  "mrrOverall",
  "mrrLexicalControl",
  "mrrNonLexical",
  "hit1Count",
  "hit10Count",
  "probeCount",
];

/**
 * 1 arm のオブジェクトが必須項目をすべて正しい型で持っているかを検査する。
 *
 * @param {unknown} arm
 * @returns {string[]} 欠けている/型が違う項目の説明。空なら問題無し。
 */
function findArmFieldProblems(arm) {
  if (typeof arm !== "object" || arm === null) {
    return ["arm がオブジェクトでない"];
  }
  const problems = [];
  for (const field of REQUIRED_ARM_STRING_FIELDS) {
    if (typeof arm[field] !== "string" || arm[field] === "") {
      problems.push(`${field} が文字列でない、または空`);
    }
  }
  for (const field of REQUIRED_ARM_NUMBER_FIELDS) {
    if (typeof arm[field] !== "number" || Number.isNaN(arm[field])) {
      problems.push(`${field} が数値でない`);
    }
  }
  return problems;
}

/**
 * `MNEMORA_RETRIEVAL_JSON` が吐いた JSON(パース済み)の形を検査する。
 *
 * **壊れている、と判定する条件はここに限定する**(呼び出し契約: 基準値との相違では
 * 落とさない。ここで拾うのは「読めても、中身が retrieval-quality の実測結果として
 * 使えない」場合だけ)。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: { arms: Record<string, unknown>[] } } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  const arms = /** @type {{ arms?: unknown }} */ (data).arms;
  if (!Array.isArray(arms) || arms.length === 0) {
    return { ok: false, error: "実測 JSON に arms 配列が無い、または空である" };
  }
  const problems = [];
  arms.forEach((arm, i) => {
    const armProblems = findArmFieldProblems(arm);
    if (armProblems.length > 0) {
      problems.push(`arms[${i}]: ${armProblems.join(" / ")}`);
    }
  });
  if (problems.length > 0) {
    return { ok: false, error: `実測 JSON の arm に必須項目が無い: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {{ arms: Record<string, unknown>[] }} */ (data) };
}

/**
 * 基準値ファイル(パース済み)の形を検査する。実測と同じ `arms` の形を要求する
 * (基準値ファイルの `_readme`/`provenance` 等の付帯情報は見ない——見る理由が無い)。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: { arms: Record<string, unknown>[] } } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  const arms = /** @type {{ arms?: unknown }} */ (data).arms;
  if (!Array.isArray(arms)) {
    return { ok: false, error: "基準値 JSON に arms 配列が無い" };
  }
  const problems = [];
  arms.forEach((arm, i) => {
    const armProblems = findArmFieldProblems(arm);
    if (armProblems.length > 0) {
      problems.push(`arms[${i}]: ${armProblems.join(" / ")}`);
    }
  });
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON の arm に必須項目が無い: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {{ arms: Record<string, unknown>[] }} */ (data) };
}

/** `4/7` の形。 */
function formatFraction(count, total) {
  return `${count}/${total}`;
}

/** MRR を既存のベンチの表示(`toFixed(3)`)に揃える。 */
function formatMrr(value) {
  return value.toFixed(3);
}

const DIFF_FIELDS = [
  "llmMode",
  "embeddingMode",
  "mrrOverall",
  "mrrLexicalControl",
  "mrrNonLexical",
  "hit1Count",
  "hit10Count",
  "probeCount",
];

/**
 * 実測の arm 1件と、対応する基準値の arm(無ければ `undefined`)を比べる。
 *
 * **`armLabel` の完全一致で対応付ける。**arm の数や順番が変わっても、ラベルさえ
 * 変わらなければ正しく比較できる(ADR 0068 §2「arm を跨いで拾える形」の逆——
 * ここでは意図して同じ arm 同士だけを突き合わせる)。
 *
 * @param {Record<string, unknown>} measuredArm
 * @param {Record<string, unknown> | undefined} baselineArm
 * @returns {{ armLabel: string, matches: boolean, missingBaseline: boolean, fieldDiffs: { field: string, baseline: unknown, measured: unknown }[] }}
 */
export function diffArm(measuredArm, baselineArm) {
  const armLabel = /** @type {string} */ (measuredArm.armLabel);
  if (!baselineArm) {
    return { armLabel, matches: false, missingBaseline: true, fieldDiffs: [] };
  }
  const fieldDiffs = [];
  for (const field of DIFF_FIELDS) {
    if (measuredArm[field] !== baselineArm[field]) {
      fieldDiffs.push({ field, baseline: baselineArm[field], measured: measuredArm[field] });
    }
  }
  return { armLabel, matches: fieldDiffs.length === 0, missingBaseline: false, fieldDiffs };
}

/**
 * arm ごとの表(ADR 0068 ② の形: arm・モード・MRR・`hit@1`・`hit@10` を同一行に置く)。
 *
 * @param {Record<string, unknown>[]} arms
 */
function buildArmTable(arms) {
  const header =
    "| arm | llmMode | embeddingMode | MRR(全体) | MRR(lexicalControl) | MRR(非語彙) | hit@1 | hit@10 |";
  const sep = "|---|---|---|---|---|---|---|---|";
  const rows = arms.map((arm) => {
    const mrrOverall = formatMrr(/** @type {number} */ (arm.mrrOverall));
    const mrrLexical = formatMrr(/** @type {number} */ (arm.mrrLexicalControl));
    const mrrNonLexical = formatMrr(/** @type {number} */ (arm.mrrNonLexical));
    const hit1 = formatFraction(arm.hit1Count, arm.probeCount);
    const hit10 = formatFraction(arm.hit10Count, arm.probeCount);
    return (
      `| ${arm.armLabel} | ${arm.llmMode} | ${arm.embeddingMode} | ${mrrOverall} | ` +
      `${mrrLexical} | ${mrrNonLexical} | ${hit1} | ${hit10} |`
    );
  });
  return [header, sep, ...rows].join("\n");
}

/**
 * 基準値との差分節。**一致なら1行、違うときだけ展開する**(呼び出し契約 / PR 本文)
 * ——常に同じ量を出す観測口は読まれない、という判断をここで実装する。
 *
 * @param {Record<string, unknown>[]} measuredArms
 * @param {Record<string, unknown>[]} baselineArms
 */
function buildDiffSection(measuredArms, baselineArms) {
  const baselineByLabel = new Map(baselineArms.map((arm) => [arm.armLabel, arm]));
  const measuredLabels = new Set(measuredArms.map((arm) => arm.armLabel));
  const diffs = measuredArms.map((arm) => diffArm(arm, baselineByLabel.get(arm.armLabel)));
  const extraBaselineArms = baselineArms.filter((arm) => !measuredLabels.has(arm.armLabel));

  const allMatch = diffs.every((d) => d.matches) && extraBaselineArms.length === 0;

  const lines = ["## 基準値との差分", ""];
  if (allMatch) {
    lines.push("✅ 一致（差分なし）。");
    return lines.join("\n");
  }

  const mismatched = diffs.filter((d) => !d.matches);
  lines.push(
    `⚠ 基準値と相違した arm が ${mismatched.length} 件ある` +
      "（🔴 これは失敗ではない——decay/freshness やコードの変更で値が動くことは起こり得る。" +
      "下の内訳を読み、意図した変化かどうかを人が判断すること）。",
  );
  for (const diff of mismatched) {
    lines.push("", `### ${diff.armLabel}`);
    if (diff.missingBaseline) {
      lines.push("", "この arm には基準値が無い（新しい arm か、基準値がまだ追随していない）。");
      continue;
    }
    lines.push("", "| 項目 | 基準値 | 実測 |", "|---|---|---|");
    for (const fieldDiff of diff.fieldDiffs) {
      lines.push(`| ${fieldDiff.field} | ${fieldDiff.baseline} | ${fieldDiff.measured} |`);
    }
  }
  if (extraBaselineArms.length > 0) {
    lines.push(
      "",
      `### 基準値にのみ存在する arm（今回の実測には無い）`,
      "",
      ...extraBaselineArms.map((arm) => `- ${arm.armLabel}`),
    );
  }
  return lines.join("\n");
}

/**
 * ADR への参照は**相対パスのリンクにしない**——このセクションの出力先は
 * `$GITHUB_STEP_SUMMARY`（GitHub Actions の run ページ）であり、そこはリポジトリの
 * ファイルツリーの上に立っていない。相対リンクを置くと、クリックしても解決しない
 * 死んだリンクになる。絶対 URL（`main` ブランチ）にしておけば、少なくとも踏める。
 */
const REPO_BLOB_BASE = "https://github.com/takecchi/mnemora/blob/main/docs/decisions";

/** 3つの必須の読み方の注意書き(PR 本文で指定された内容そのもの)。 */
function buildCautionSection() {
  return [
    "## 読み方の注意",
    "",
    "- ⚠ **動いているのは `similarity` ただ1項である。**このベンチの呼び方" +
      "（`recall(ctx, {text})` のみ）では、候補集合の上で `tagMatch`/`strength` は" +
      "厳密に1通りしか値を取らず順位に構造上ゼロ寄与し、`decay` の変域は `similarity` より" +
      "約10⁶〜10⁷倍小さく、`freshness` は `decay` の行ごと厳密な複製である" +
      `（[ADR 0081](${REPO_BLOB_BASE}/0081-similarity-is-the-only-term-that-ranks.md) §1・§2）。`,
    "- ⚠ **標本は probe 7件である。ここから失敗率も成功率も主張しない**" +
      `（[ADR 0033](${REPO_BLOB_BASE}/0033-what-decided-the-rank-in-the-retrieval-bench.md) §3）。`,
    "- ⚠ **埋め込みは否定・時制・矛盾を解かない。**実測例: 「紅茶よりコーヒーが好き」と" +
      "「コーヒーより紅茶が好き」は意味が逆だが、コサイン類似度は 0.996 である。" +
      "⟹ **この値が上がっても「精度が上がった」と一言でまとめてはいけない。**",
    "",
  ].join("\n");
}

/**
 * Markdown を組み立てる(このスクリプトの主機能)。**stdout に出すのは呼び出し側の役目**
 * ——ここは文字列を返すだけ。
 *
 * @param {{ measured: { arms: Record<string, unknown>[] }, baseline?: { arms: Record<string, unknown>[] } }} input
 * @returns {string}
 */
export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = [
    "# retrieval bench の実測（記録した実 API 応答の再生・機械可読サマリ）",
    "",
    "## arm ごとの結果",
    "",
    buildArmTable(measured.arms),
    "",
  ];
  if (baseline) {
    lines.push(buildDiffSection(measured.arms, baseline.arms), "");
  }
  lines.push(buildCautionSection());
  return lines.join("\n");
}

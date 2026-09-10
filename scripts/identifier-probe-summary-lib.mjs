/**
 * `scripts/identifier-probe-summary.mjs`(CI の Job Summary に載せる Markdown を組み立てる
 * CLI)の純関数の側。ファイル I/O・`process.argv`・`process.exit` を一切持たない
 * ——`scripts/retrieval-quality-summary-lib.mjs` と同じ分担・同じ理由(Issue #109)。
 *
 * `examples/chat` の `identifier-probes` サブコマンド(`MNEMORA_IDENTIFIER_PROBE_JSON` が
 * 吐く JSON、`examples/chat/src/identifier-json.ts` の `IdentifierProbeRunJson`)を
 * Markdown へ変換する。
 *
 * 🔴 **`status` で最初に分岐する。**`"weights_unavailable"` と `"measured"` を
 * 同じ顔で出さない——オーナー代理の懸念(「HF から取得できなかった」が「想起の質が
 * 下がった」に見えてはならない)を、この出力の形そのもので体現する。
 * `"weights_unavailable"` のときはメトリクスの表を1つも出さず、**基準値との比較も
 * 1つも出さない**(`buildSummaryMarkdown` 参照)——⛔ 「測れなかった」を「基準値と
 * 違う」に化けさせない。
 *
 * ## 基準値(`examples/chat/identifier-probe-baseline.json`)を読む理由
 *
 * ⚠ **このファイルは以前「基準値を読まない」と書いていた。その理由付けは
 * 取り違えだった**——レビューで見つけて直した(ADR 0094 §8)。
 *
 * **「⛔ 門にしない」と「⛔ 基準値と比べない」は別のことである。**
 * [ADR 0088](../docs/decisions/0088-retrieval-quality-measured-in-ci.md) §3 は
 * **両方を同時にやっている**——基準値と diff を取って Job Summary に出し、**かつ**
 * 相違では落とさない。そして §3 は、この repo の先例(`ci.yml` の `compare` ステップ)を
 * 挙げて逐語でこう書いている:
 *
 * > **⟹ 約束したのは「表を生ログに出すこと」であり、表の中身に対する assertion は
 * > 1つも無い。**…**⟹ 気づくかどうかは、人間が生ログを開くかどうかに委ねられている。**
 * > **⛔ この ADR は同じ形を繰り返さない。**
 *
 * **基準値ファイルがコミットされているのに誰もそれと比べないなら、値が動いても
 * 誰も気づかず、誰も基準値を更新せず、⟹ 新しい値が PR の diff に現れる輪が閉じない。**
 * それは ADR 0088 §3 が名指しした形の再発である。⟹ だから比べる。
 *
 * 採る形は ADR 0088 §3 の3点そのままである:
 *
 * 1. 基準値を repo にコミットする(出所を添えて。既にある)。
 * 2. 差分を Job Summary に出す(生ログではない)。
 * 3. **一致しているときは1行で黙り、違うときだけ展開する**
 *    ——⭐ 常に同じ量を出す観測口は読まれない。
 *
 * ## ⛔ それでも門にはしない
 *
 * 相違で非0を返さない(`identifier-probe-summary.mjs` の exit code)。probe は
 * 12件(識別子)・7件(日本語)であり、
 * [ADR 0033](../docs/decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md) §3 の
 * 規律に照らして閾値の門に足る母数ではない。**⚠ 「なぜ*今は*門にしないか」**:
 * probe を増やした後に、その母数で偽陽性が出ないかを測ってから別途決める
 * (載っているのに門にしないのは怠慢だ、と次の人に読まれないための1行)。
 * 非0になるのは**入力そのものが壊れているとき**だけである。
 *
 * ## 🔴 比べるのは数字だけではない
 *
 * `embeddingSpace`(`provider`/`model`/`dimensions`)と `haystackKind` も比べる。
 * ⛔ 数字だけを比べると、**空間や haystack 条件が変わったのに数字が同じ**場合を
 * 「一致」と出してしまう——`local`/`ruri-v3-30m/sym`/**256次元** と
 * `openai`/`text-embedding-3-small`/**256次元** は、次元数が同じでも別の空間である。
 * この repo が3度壊した「条件を落とした数字」を、比較の側でも作らない。
 */

/**
 * 群の同一性は**群の名前**(`japanese`/`identifiersSparse`/`identifiersDense`)で取る。
 * ⛔ `label` では取らない——`label` は `(llm, provider/model/dimensions, haystack)` を
 * 文字列に埋めたものであり、**モデルを差し替えると label ごと変わる**。label を鍵に
 * すると、そのとき出るのは「embeddingSpace.model が変わった」ではなく
 * 「基準値に無い群が現れ、基準値にしか無い群が残った」になり、**何が変わったのかが
 * 読めなくなる。**群の名前は条件が変わっても不変なので、鍵にはこちらを使い、
 * `label` は**比較する項目**の側に置く。
 *
 * ⟹ 基準値ファイルの各群も、この名前を `group` として明示的に持つ
 * (実測 JSON 側はこの名前がそのままキーである)。
 */
const GROUP_KEYS = ["japanese", "identifiersSparse", "identifiersDense"];

const REQUIRED_GROUP_STRING_FIELDS = ["label", "llmMode", "embeddingMode", "haystackKind"];
const REQUIRED_GROUP_NUMBER_FIELDS = ["mrrOverall", "hit1Count", "hit10Count", "probeCount"];

/**
 * 🔴 **`examples/chat/src/local-embedding-warmup.ts` の
 * `WEIGHTS_UNAVAILABLE_PREFIX` と同じ文言をここに逐語で持つ。**
 *
 * ⚠ **`detail` に含まれているから出る、という形にしない。**`detail` は bench が
 * 投げてきたデータであり、文言が変わればこの要約から消える。オーナー代理が指定した
 * 文言は「この要約自体が言うこと」でなければならない——だから要約側の見出しに
 * 逐語で持ち、`detail` は別に(そのまま)出す。
 *
 * ⚠ TS 側の定数を import できない(このファイルは素の `.mjs` であり、CI の
 * Job Summary の段は `tsx` を通さない)。**二重管理であることを認めて書いておく**
 * ——文言を変えるときは両方を直すこと。歯(`scripts/__tests__/` と
 * `examples/chat/src/__tests__/local-embedding-warmup.test.ts`)が両側で逐語を
 * 検査しているので、片方だけ変えれば赤くなる。
 */
const WEIGHTS_UNAVAILABLE_PHRASE = "重みを取得できなかったので、値は測っていない";

/**
 * 1群(`japanese`/`identifiersSparse`/`identifiersDense`)のオブジェクトが必須項目を
 * すべて正しい型で持っているかを検査する。
 *
 * @param {unknown} group
 * @param {string} groupName
 * @returns {string[]}
 */
function findGroupFieldProblems(group, groupName) {
  if (typeof group !== "object" || group === null) {
    return [`${groupName} がオブジェクトでない`];
  }
  const problems = [];
  for (const field of REQUIRED_GROUP_STRING_FIELDS) {
    if (typeof group[field] !== "string" || group[field] === "") {
      problems.push(`${groupName}.${field} が文字列でない、または空`);
    }
  }
  for (const field of REQUIRED_GROUP_NUMBER_FIELDS) {
    if (typeof group[field] !== "number" || Number.isNaN(group[field])) {
      problems.push(`${groupName}.${field} が数値でない`);
    }
  }
  const space = group.embeddingSpace;
  if (typeof space !== "object" || space === null) {
    problems.push(`${groupName}.embeddingSpace がオブジェクトでない`);
  } else {
    for (const field of ["provider", "model"]) {
      if (typeof space[field] !== "string" || space[field] === "") {
        problems.push(`${groupName}.embeddingSpace.${field} が文字列でない、または空`);
      }
    }
    if (typeof space.dimensions !== "number") {
      problems.push(`${groupName}.embeddingSpace.dimensions が数値でない`);
    }
  }
  return problems;
}

/**
 * `MNEMORA_IDENTIFIER_PROBE_JSON` が吐いた JSON(パース済み)の形を検査する。
 *
 * **壊れている、と判定する条件はここに限定する**——`status: "weights_unavailable"`
 * それ自体は壊れた入力ではない(`detail` さえ在れば正しい形)。壊れているのは
 * JSON がオブジェクトでない・`status` が未知の値・`"measured"` なのに群の必須項目が
 * 欠けている場合だけである。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  const status = /** @type {{ status?: unknown }} */ (data).status;
  if (status === "weights_unavailable") {
    const detail = /** @type {{ detail?: unknown }} */ (data).detail;
    if (typeof detail !== "string" || detail === "") {
      return { ok: false, error: "weights_unavailable な JSON に detail が無い、または空" };
    }
    return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
  }
  if (status !== "measured") {
    return { ok: false, error: `status が不明な値である(実際: ${JSON.stringify(status)})` };
  }
  const problems = [];
  for (const groupName of GROUP_KEYS) {
    problems.push(...findGroupFieldProblems(/** @type {any} */ (data)[groupName], groupName));
  }
  if (problems.length > 0) {
    return { ok: false, error: `実測 JSON の群に必須項目が無い: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

/**
 * 基準値ファイル(`examples/chat/identifier-probe-baseline.json`、パース済み)の形を
 * 検査する。実測と同じ必須項目を、`groups` 配列の各要素に要求する
 * (`_readme`/`provenance` 等の付帯情報は見ない——見る理由が無い)。
 *
 * **各要素は `group`(`japanese`/`identifiersSparse`/`identifiersDense`)を持つこと。**
 * ⚠ 配列の順番を同一性の根拠にしない——並べ替えただけで別の群と突き合わせて
 * 「一致」を出す形は、この repo が繰り返し壊してきた「条件を取り違えた数字」そのもの
 * である。**名前で突き合わせ、名前が無ければ入力が壊れていると言う。**
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: { groups: Record<string, unknown>[] } } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  const groups = /** @type {{ groups?: unknown }} */ (data).groups;
  if (!Array.isArray(groups)) {
    return { ok: false, error: "基準値 JSON に groups 配列が無い" };
  }
  const problems = [];
  const seen = new Set();
  groups.forEach((group, i) => {
    const groupName = /** @type {any} */ (group)?.group;
    if (typeof groupName !== "string" || !GROUP_KEYS.includes(groupName)) {
      problems.push(
        `groups[${i}].group が ${GROUP_KEYS.join("/")} のいずれでもない` +
          `(実際: ${JSON.stringify(groupName)})`,
      );
      return;
    }
    if (seen.has(groupName)) {
      problems.push(`groups に ${groupName} が2件以上ある`);
      return;
    }
    seen.add(groupName);
    problems.push(...findGroupFieldProblems(group, `groups[${i}](${groupName})`));
  });
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON の群が使えない: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {{ groups: Record<string, unknown>[] }} */ (data) };
}

/** `4/7` の形。 */
function formatFraction(count, total) {
  return `${count}/${total}`;
}

/** MRR を既存のベンチの表示(`toFixed(3)`)に揃える。 */
function formatMrr(value) {
  return /** @type {number} */ (value).toFixed(3);
}

/** `(provider, model, dimensions)` を1つの文字列にする——次元数だけでは区別できない
 *  (`text-embedding-3-small` も256次元)ため、必ず3つ揃えて出す。 */
function formatSpace(space) {
  return `${space.provider}/${space.model}/${space.dimensions}次元`;
}

/**
 * @param {Record<string, any>} group
 */
function buildGroupRow(group) {
  return (
    `| ${group.label} | ${group.llmMode} | ${formatSpace(group.embeddingSpace)} | ` +
    `${group.haystackKind} | ${formatMrr(group.mrrOverall)} | ` +
    `${formatFraction(group.hit1Count, group.probeCount)} | ` +
    `${formatFraction(group.hit10Count, group.probeCount)} |`
  );
}

/**
 * 基準値と突き合わせる項目。🔴 **数字だけではない**——`embeddingSpace` の3項目と
 * `haystackKind`、そして条件を文字列に埋めた `label` も含む(冒頭 docstring 参照)。
 */
const DIFF_FIELDS = [
  "label",
  "llmMode",
  "embeddingMode",
  "embeddingSpace.provider",
  "embeddingSpace.model",
  "embeddingSpace.dimensions",
  "haystackKind",
  "mrrOverall",
  "hit1Count",
  "hit10Count",
  "probeCount",
];

/**
 * `"embeddingSpace.provider"` のような入れ子のパスを読む。
 *
 * @param {Record<string, any> | undefined} obj
 * @param {string} path
 */
function readPath(obj, path) {
  return path
    .split(".")
    .reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

/**
 * 実測の1群と、対応する基準値の1群(無ければ `undefined`)を比べる。
 *
 * @param {string} groupName `japanese`/`identifiersSparse`/`identifiersDense`
 * @param {Record<string, any>} measuredGroup
 * @param {Record<string, any> | undefined} baselineGroup
 * @returns {{ groupName: string, matches: boolean, missingBaseline: boolean, fieldDiffs: { field: string, baseline: unknown, measured: unknown }[] }}
 */
export function diffGroup(groupName, measuredGroup, baselineGroup) {
  if (!baselineGroup) {
    return { groupName, matches: false, missingBaseline: true, fieldDiffs: [] };
  }
  const fieldDiffs = [];
  for (const field of DIFF_FIELDS) {
    const baseline = readPath(baselineGroup, field);
    const measured = readPath(measuredGroup, field);
    if (baseline !== measured) {
      fieldDiffs.push({ field, baseline, measured });
    }
  }
  return { groupName, matches: fieldDiffs.length === 0, missingBaseline: false, fieldDiffs };
}

/**
 * 基準値との差分節。**一致なら1行、違うときだけ展開する**(ADR 0088 §3-3)
 * ——常に同じ量を出す観測口は読まれない。
 *
 * @param {Record<string, any>} measured
 * @param {{ groups: Record<string, unknown>[] }} baseline
 */
function buildDiffSection(measured, baseline) {
  const baselineByGroup = new Map(
    baseline.groups.map((group) => [/** @type {any} */ (group).group, group]),
  );
  const diffs = GROUP_KEYS.map((groupName) =>
    diffGroup(groupName, measured[groupName], baselineByGroup.get(groupName)),
  );
  const extraBaselineGroups = baseline.groups.filter(
    (group) => !GROUP_KEYS.includes(/** @type {any} */ (group).group),
  );

  const lines = ["## 基準値との差分", ""];
  if (diffs.every((diff) => diff.matches) && extraBaselineGroups.length === 0) {
    lines.push(
      "✅ 一致（差分なし）。3群すべてで label / llmMode / embeddingMode / " +
        "embeddingSpace(provider, model, dimensions) / haystackKind / MRR / hit@1 / hit@10 / " +
        "probe件数 が `examples/chat/identifier-probe-baseline.json` と同じだった。",
    );
    return lines.join("\n");
  }

  const mismatched = diffs.filter((diff) => !diff.matches);
  lines.push(
    `⚠ 基準値と相違した群が ${mismatched.length} 件ある` +
      "（🔴 これは失敗ではない——コードの変更で値が動くことは起こり得る。" +
      "下の内訳を読み、意図した変化かどうかを人が判断し、意図した変化なら" +
      "基準値ファイルを更新すること）。",
  );
  for (const diff of mismatched) {
    lines.push("", `### ${diff.groupName}`);
    if (diff.missingBaseline) {
      lines.push("", "この群には基準値が無い（新しい群か、基準値がまだ追随していない）。");
      continue;
    }
    lines.push("", "| 項目 | 基準値 | 実測 |", "|---|---|---|");
    for (const fieldDiff of diff.fieldDiffs) {
      lines.push(`| ${fieldDiff.field} | ${fieldDiff.baseline} | ${fieldDiff.measured} |`);
    }
  }
  if (extraBaselineGroups.length > 0) {
    lines.push(
      "",
      "### 基準値にのみ存在する群（今回の実測には無い）",
      "",
      ...extraBaselineGroups.map((group) => `- ${/** @type {any} */ (group).group}`),
    );
  }
  return lines.join("\n");
}

/**
 * `validateMeasured`/`validateBaseline` を通した値から Markdown を組み立てる。
 * **呼び出し側は必ず validate 済みの値を渡すこと**
 * (`retrieval-quality-summary-lib.mjs` と同じ分担)。
 *
 * `baseline` は任意である。渡されていても、`status: "weights_unavailable"` のときは
 * **1つも比較を出さない**——⛔ 「測れなかった」を「基準値と違う」に化けさせない。
 *
 * @param {{ measured: Record<string, any>, baseline?: { groups: Record<string, unknown>[] } }} input
 */
export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = ["# identifier-probes（Issue #109 / #106）"];

  if (measured.status === "weights_unavailable") {
    lines.push(
      "",
      `## 🔴 ${WEIGHTS_UNAVAILABLE_PHRASE} — メトリクスは1件も出さない`,
      "",
      "前回の値・既定値・`0` のいずれへも倒していない。**基準値との比較も1つも" +
        "行っていない**——測っていない値を「基準値と違う」に化けさせないためである。",
      "",
      "以下は実際に投げられた理由である:",
      "",
      "```",
      String(measured.detail),
      "```",
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    "✅ 測定できた。",
    "",
    "| 群 | llmMode | embeddingSpace(provider/model/dimensions) | haystack | MRR | hit@1 | hit@10 |",
    "|---|---|---|---|---|---|---|",
    buildGroupRow(measured.japanese),
    buildGroupRow(measured.identifiersSparse),
    buildGroupRow(measured.identifiersDense),
    "",
  );
  if (baseline) {
    lines.push(buildDiffSection(measured, baseline), "");
  }
  lines.push(
    "⚠ ADR 0033 §3: 標本7件・12件からは失敗率も成功率も統計的に主張しない。" +
      "ここで言えるのは「今回、この母数のうち何件引けたか」までである。",
    "",
    "⚠ `identifiersSparse`/`identifiersDense` は同じ12 probe・同じ埋め込み空間で、" +
      "haystack(識別子の密度)だけが違う——2つを混ぜた単一の MRR ではない。",
  );
  return lines.join("\n");
}

#!/usr/bin/env node
/**
 * `examples/chat` の `identifier-probes` ベンチ(`MNEMORA_IDENTIFIER_PROBE_JSON` が吐く
 * JSON)を人が読める Markdown へ変換し、CI の Job Summary(`$GITHUB_STEP_SUMMARY`)へ
 * 載せる CLI(Issue #109)。
 *
 * 組み立ては `./identifier-probe-summary-lib.mjs` の純関数に委ねる
 * (`retrieval-quality-summary.mjs`/`-lib.mjs` と同じ分担)。ここは
 *
 * 1. `--measured <path>`(必須)・`--baseline <path>`(任意)を読む
 * 2. ファイルを読んで JSON.parse する(壊れていたら理由を stderr に出して非0で終わる)
 * 3. 形を検査する(`validateMeasured`/`validateBaseline`。壊れていたら同様に非0)
 * 4. Markdown を stdout に出す
 *
 * だけを行う。
 *
 * 使い方:
 *   node scripts/identifier-probe-summary.mjs --measured <path> [--baseline <path>]
 *
 * 🔴 **基準値ファイルと相違しても exit 0 のままである。**これは意図した設計であり、
 * バグではない——**「⛔ 門にしない」と「⛔ 基準値と比べない」は別のことである**
 * (`./identifier-probe-summary-lib.mjs` の冒頭 docstring を読むこと。ADR 0088 §3 は
 * 両方を同時にやっている: 差分を Job Summary に出し、かつ相違では落とさない)。
 * **このスクリプトは門ではない。**非0になるのは、入力そのものが壊れているとき
 * (measured の JSON が読めない・parse できない・`status` が未知・`"measured"` なのに
 * 必須項目が無い。`--baseline` を指定していて、それが読めない/壊れている場合も含む)
 * だけである。
 *
 * 🔴 **`status: "weights_unavailable"` でも exit 0 である。**それ自体は「正しく壊れた」
 * 結果であり、この要約スクリプトにとっての「入力が壊れている」ではない。
 * ⚠ そのとき **`--baseline` を渡していても比較は1つも出さない**
 * (`buildSummaryMarkdown`)——⛔ 「測れなかった」を「基準値と違う」に化けさせない。
 * ⚠ **`identifier-probes` を実行する CI ステップ自体は、重みが取得できなければ non-zero
 * で終わる**(仕様どおり)——それとこのスクリプトの exit code は別の話である。
 */
import { readFileSync } from "node:fs";
import {
  buildSummaryMarkdown,
  validateBaseline,
  validateMeasured,
} from "./identifier-probe-summary-lib.mjs";

const args = process.argv.slice(2);

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

const measuredPath = readArgValue("--measured");
const baselinePath = readArgValue("--baseline");

if (!measuredPath) {
  console.error(
    "使い方: node scripts/identifier-probe-summary.mjs --measured <path> [--baseline <path>]",
  );
  process.exit(1);
}

/**
 * ファイルを読んで JSON.parse する。**読めない/parse できない理由をそのまま返す**
 * ——「壊れている」と一括りにせず、次に来る人がどこを見ればいいか分かるようにする
 * (`retrieval-quality-summary.mjs` の `readJson` と同じ形)。
 *
 * @param {string} path
 * @param {string} label
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `${label} JSON を読めない（${path}）: ${err.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `${label} JSON の parse に失敗した（${path}）: ${err.message}` };
  }
}

const measuredRead = readJson(measuredPath, "実測");
if (!measuredRead.ok) {
  console.error(measuredRead.error);
  process.exit(1);
}
const measuredValidated = validateMeasured(measuredRead.value);
if (!measuredValidated.ok) {
  console.error(measuredValidated.error);
  process.exit(1);
}

let baselineValidated;
if (baselinePath) {
  const baselineRead = readJson(baselinePath, "基準値");
  if (!baselineRead.ok) {
    console.error(baselineRead.error);
    process.exit(1);
  }
  baselineValidated = validateBaseline(baselineRead.value);
  if (!baselineValidated.ok) {
    console.error(baselineValidated.error);
    process.exit(1);
  }
}

console.log(
  buildSummaryMarkdown({
    measured: measuredValidated.value,
    ...(baselineValidated ? { baseline: baselineValidated.value } : {}),
  }),
);
// **明示的に 0 を宣言する**——`--baseline` が相違を含んでいても、`status` が
// `weights_unavailable` でも、ここまで来たら入力は壊れていない。門ではない、という
// 設計の要をコード上で目に見える形にする(`retrieval-quality-summary.mjs` と同じ)。
process.exit(0);

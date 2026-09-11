#!/usr/bin/env node
/**
 * `examples/chat` の `consolidation-cost` ベンチ(`MNEMORA_CONSOLIDATION_JSON` が吐く
 * JSON)を人が読める Markdown へ変換し、CI の Job Summary(`$GITHUB_STEP_SUMMARY`)へ
 * 載せる CLI(Issue #136)。
 *
 * 組み立ては `./consolidation-cost-summary-lib.mjs` の純関数に委ねる
 * (`retrieval-quality-summary.mjs`/`identifier-probe-summary.mjs` と同じ分担)。ここは
 *
 * 1. `--measured <path>`(必須)・`--baseline <path>`(任意)を読む
 * 2. ファイルを読んで JSON.parse する(壊れていたら理由を stderr に出して非0で終わる)
 * 3. 形を検査する(`validateMeasured`/`validateBaseline`。壊れていたら同様に非0)
 * 4. Markdown を stdout に出す
 *
 * だけを行う。
 *
 * 使い方:
 *   node scripts/consolidation-cost-summary.mjs --measured <path> [--baseline <path>]
 *
 * 🔴 **基準値ファイルと相違しても exit 0 のままである。**これは意図した設計であり、
 * バグではない(ADR 0088 §2.1 / §3 と同じ判断)。**このスクリプトは門ではない。**
 * 非0になるのは、入力そのものが壊れているとき(measured の JSON が読めない・
 * parse できない・必須項目が無い。`--baseline` を指定していて、それが読めない/
 * 壊れている場合も含む)だけである。
 */
import { readFileSync } from "node:fs";
import {
  validateBaseline,
  validateMeasured,
  buildSummaryMarkdown,
} from "./consolidation-cost-summary-lib.mjs";

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
    "使い方: node scripts/consolidation-cost-summary.mjs --measured <path> [--baseline <path>]",
  );
  process.exit(1);
}

/**
 * @param {string} path
 * @param {string} label
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `${label} JSON を読めない(${path}): ${err.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `${label} JSON の parse に失敗した(${path}): ${err.message}` };
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

const markdown = buildSummaryMarkdown({
  measured: measuredValidated.value,
  ...(baselineValidated ? { baseline: baselineValidated.value } : {}),
});

console.log(markdown);
// 明示的に0を宣言する——`--baseline` が相違を含んでいても、ここまで来たら入力は
// 壊れていない。門ではない、という設計の要をコード上で目に見える形にする。
process.exit(0);

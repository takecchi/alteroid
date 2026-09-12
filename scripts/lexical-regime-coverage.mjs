#!/usr/bin/env node
/**
 * `postgres` ジョブ(matrix 化後)の各脚が残した `lexical-regime-<encoding>` artifact を
 * 集めて、**両方の regime が実際に走ったか**を検査する CLI(Issue #155 満たすべきこと2)。
 *
 * 組み立ては `./lexical-regime-coverage-lib.mjs` の純関数に委ねる
 * (`lexical-regime-summary.mjs` と同じ分担)。ここは
 *
 * 1. `--artifacts-dir <dir>` (必須)を読む。`actions/download-artifact@v6` が
 *    `pattern: lexical-regime-*` でダウンロードした先を渡す想定
 *    (各 artifact 名のディレクトリの下に `lexical-regime.json` が1個ずつ並ぶ)。
 * 2. `EXPECTED_SERVER_ENCODINGS` の各脚について、そのディレクトリ/ファイルを読む。
 * 3. Markdown を stdout に出す(⭐先に出す。`lexical-regime-summary.mjs` と同じ理由——
 *    赤くなるときこそ Job Summary に状態が残らないと意味がない)。
 * 4. `evaluateCoverage` が非 ok なら stderr に理由を出して非0で終わる。
 *
 * 使い方:
 *   node scripts/lexical-regime-coverage.mjs --artifacts-dir <dir>
 *
 * ⛔ **このスクリプトは `postgres` ジョブ自体が skip されたかどうかを見ない。**
 * それは呼び出し側(ci.yml の `postgres-regime-coverage` ジョブ)が
 * `needs.postgres.result` を先に見て行う——このスクリプトが見るのは
 * 「artifact が実際に両方揃っているか」だけである。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPECTED_SERVER_ENCODINGS,
  artifactNameForEncoding,
  buildCoverageSummaryMarkdown,
  evaluateCoverage,
} from "./lexical-regime-coverage-lib.mjs";

const args = process.argv.slice(2);

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

const artifactsDir = readArgValue("--artifacts-dir");

if (!artifactsDir) {
  console.error("使い方: node scripts/lexical-regime-coverage.mjs --artifacts-dir <dir>");
  process.exit(1);
}

const legs = EXPECTED_SERVER_ENCODINGS.map((encoding) => {
  const jsonPath = join(artifactsDir, artifactNameForEncoding(encoding), "lexical-regime.json");
  if (!existsSync(jsonPath)) {
    return { encoding, present: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    return { encoding, present: true, measuredEncoding: parsed.serverEncoding };
  } catch (err) {
    return { encoding, present: true, error: err.message };
  }
});

const result = evaluateCoverage(legs);

// ⭐ 先に Markdown を stdout へ出す(順序が重要。lexical-regime-summary.mjs と同じ理由)。
console.log(buildCoverageSummaryMarkdown(legs, result));

if (!result.ok) {
  console.error(result.problems.join("\n"));
  process.exit(1);
}

process.exit(0);

#!/usr/bin/env node
/**
 * `packages/postgres` の `lexical-store-identifier.test.ts` が測った
 * server_encoding regime(`MNEMORA_LEXICAL_REGIME_JSON` が吐く JSON)を人が読める
 * Markdown へ変換し、CI の Job Summary(`$GITHUB_STEP_SUMMARY`)へ載せる CLI(Issue #148)。
 *
 * 組み立ては `./lexical-regime-summary-lib.mjs` の純関数に委ねる
 * (`consolidation-cost-summary.mjs`/`identifier-probe-summary.mjs` と同じ分担)。ここは
 *
 * 1. `--measured <path>`(必須)を読む
 * 2. ファイルを読んで JSON.parse する(壊れていたら理由を stderr に出して非0で終わる)
 * 3. 形を検査する(`validateMeasured`。壊れていたら同様に非0)
 * 4. Markdown を stdout に出す
 *
 * だけを行う。
 *
 * 使い方:
 *   node scripts/lexical-regime-summary.mjs --measured <path>
 *
 * ⛔ **これは門ではない。**`server_encoding`/`nonAsciiIsIndexed` がどちらの値でも
 * exit 0 のままである(基準値ファイルも置いていない——理由は
 * `lexical-regime-summary-lib.mjs` の docstring)。
 *
 * 🔴 **非0で終わる経路は3つあり、意図して別々のメッセージにしている**
 * (Issue #148 の受け入れ基準「可視化そのものが壊れても気づけること」の実装):
 *
 * 1. **ファイルが無い**(`ENOENT`) — 「値が出ていない」。歯がそもそも
 *    `MNEMORA_LEXICAL_REGIME_JSON` へ書いていない可能性がある——測定段自体が
 *    落ちていないか先に見ること、という趣旨のメッセージにする。
 * 2. **JSON の parse に失敗する** — ファイルはあるが壊れている。
 * 3. **`validateMeasured` が拒否する**(鍵が欠けている・値が空文字、等) — 「値が
 *    空だった」。これは(1)(2)のどちらとも異なるメッセージにする——「歯が書く
 *    呼び出しごと消えた」のか「歯は書いたが中身が壊れている」のかを、この段の
 *    stderr だけで見分けられるようにするため。
 *
 * これら3つは、regime の値(UTF8 か SQL_ASCII か等)を一切見ない——
 * **「可視化そのものが壊れたことの門」であって「値の門」ではない。**
 */
import { readFileSync } from "node:fs";
import { validateMeasured, buildSummaryMarkdown } from "./lexical-regime-summary-lib.mjs";

const args = process.argv.slice(2);

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

const measuredPath = readArgValue("--measured");

if (!measuredPath) {
  console.error("使い方: node scripts/lexical-regime-summary.mjs --measured <path>");
  process.exit(1);
}

let text;
try {
  text = readFileSync(measuredPath, "utf8");
} catch (err) {
  if (err.code === "ENOENT") {
    // ① 値が出ていない: 歯(lexical-store-identifier.test.ts)が
    // MNEMORA_LEXICAL_REGIME_JSON への書き込みを呼んでいない可能性がある。
    console.error(
      `regime JSON が出ていない(${measuredPath} が存在しない)。` +
        "packages/postgres の lexical-store-identifier.test.ts が " +
        "MNEMORA_LEXICAL_REGIME_JSON へ書く前に落ちたか、その呼び出しごと消えた可能性がある" +
        "——測定段(test:db)自体が落ちていないか先に見ること。",
    );
  } else {
    console.error(`regime JSON を読めない(${measuredPath}): ${err.message}`);
  }
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(text);
} catch (err) {
  // ② JSON が壊れている: ファイルは在るが、中身が JSON として読めない。
  console.error(`regime JSON の parse に失敗した(${measuredPath}): ${err.message}`);
  process.exit(1);
}

const validated = validateMeasured(parsed);
if (!validated.ok) {
  // ③ 値が空だった: ファイルも JSON としては存在するが、必須項目が欠けている・空である。
  console.error(validated.error);
  process.exit(1);
}

console.log(buildSummaryMarkdown(validated.value));
// 明示的に0を宣言する——ここまで来たら regime の値がどちらでも門にしない。
process.exit(0);

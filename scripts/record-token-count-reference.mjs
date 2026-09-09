#!/usr/bin/env node
/**
 * `packages/core/src/__tests__/fixtures/token-count-reference.json`（Issue #108）を
 * js-tiktoken で再計算し、書き直す手動スクリプト。
 *
 * **これはどの門にも入っていない**（`pnpm run test` からも CI からも呼ばれない）。
 * `js-tiktoken` を `package.json` / `pnpm-lock.yaml` に足さない判断
 * （依存の追加方針の変更はオーナー専権。`docs/autonomy.md:115`）をしたため、
 * 実行するたびに手で用意してもらう形にしてある。
 *
 * 使い方:
 *   npm i --no-save js-tiktoken   # このリポジトリのどこか（推奨: リポジトリ直下）で
 *   node scripts/record-token-count-reference.mjs
 *
 * `--no-save` なので `package.json` は書き換わらない。`node_modules/` は
 * `.gitignore` されているので、実行後に消しても消さなくても `git status` は汚れない
 * ——ただし CI の環境には `js-tiktoken` が無い前提なので、動かしたら
 * `node_modules/js-tiktoken`（と依存の `base64-js`）を消してから作業を終えること。
 *
 * ## このスクリプトが「新しい corpus」を持たない理由
 *
 * 元の測定（121件のコーパス、実 API 突き合わせ）は本タスクの外で一度だけ行われた
 * （`measure/` 以下。このリポジトリには無い一時ディレクトリ）。このスクリプトは
 * その corpus を再取得する手段を持たない——**既存のフィクスチャの `id/class/source/text`
 * を「動かない corpus」として読み直し、`o200k_base`/`cl100k_base` の列だけを
 * js-tiktoken で再計算して、フィクスチャの値と一致するか確認する。**
 *
 * `verifiedAgainstApi`（実 API に課金して確かめた記録）は再現できない
 * （もう一度叩けば新しい課金が発生する）ため、このスクリプトは**その節を書き換えない**
 * ——既存のフィクスチャからそのまま引き継いで書き戻す。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("../packages/core/src/__tests__/fixtures/token-count-reference.json", import.meta.url),
);

async function loadJsTiktoken() {
  try {
    return await import("js-tiktoken");
  } catch (err) {
    throw new Error(
      "js-tiktoken が見つからない。次を実行してから、もう一度このスクリプトを走らせること:\n" +
        "  npm i --no-save js-tiktoken\n" +
        "（--no-save なので package.json / pnpm-lock.yaml は変わらない。\n" +
        " 依存を増やさない方針のため、このリポジトリの devDependencies には入れていない。\n" +
        " docs/autonomy.md:115 参照。)",
      { cause: err },
    );
  }
}

async function main() {
  const { getEncoding } = await loadJsTiktoken();
  const o200k = getEncoding("o200k_base");
  const cl100k = getEncoding("cl100k_base");

  const before = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

  let mismatches = 0;
  const samples = before.samples.map((sample) => {
    const recomputedO200k = o200k.encode(sample.text).length;
    const recomputedCl100k = cl100k.encode(sample.text).length;
    if (recomputedO200k !== sample.o200k_base || recomputedCl100k !== sample.cl100k_base) {
      mismatches++;
      console.warn(
        `[record-token-count-reference] 再計算値が既存フィクスチャと食い違う: ${sample.id} ` +
          `o200k_base ${sample.o200k_base} -> ${recomputedO200k}, ` +
          `cl100k_base ${sample.cl100k_base} -> ${recomputedCl100k}`,
      );
    }
    return {
      ...sample,
      o200k_base: recomputedO200k,
      cl100k_base: recomputedCl100k,
    };
  });

  const after = {
    ...before,
    samples,
  };

  writeFileSync(FIXTURE_PATH, `${JSON.stringify(after, null, 2)}\n`);

  if (mismatches > 0) {
    console.warn(
      `[record-token-count-reference] ${mismatches} 件で再計算値がフィクスチャと食い違っていた` +
        "（フィクスチャは新しい値で上書き済み）。js-tiktoken のバージョン差か、" +
        "corpus 側の text が変わっていないかを確認すること。",
    );
    process.exitCode = 1;
  } else {
    console.log(
      `[record-token-count-reference] ${samples.length} 件すべて既存フィクスチャと一致した。`,
    );
  }
}

await main();

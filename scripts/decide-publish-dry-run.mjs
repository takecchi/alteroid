#!/usr/bin/env node
/**
 * `.github/workflows/publish.yml` の CLI 入口。
 *
 * 判定そのものは `./publish-dry-run.mjs` の `decideDryRun()` が持つ（副作用が無く、
 * 歯から直接呼べる）。ここでは
 *
 * 1. env から読む（`EVENT_NAME` / `DRY_RUN_INPUT`。workflow 側は `${{ }}` の直接展開
 *    ではなく `env:` 経由でこの2つを渡す——利用者が渡す `dry_run` の shell への
 *    注入面を減らすため。`github.event_name` は列挙値なので直接展開でも安全だが、
 *    ここでは揃えて `env:` にしている）
 * 2. `decideDryRun()` を呼ぶ
 * 3. 警告があれば `::warning::` を stdout へ出す（GitHub Actions の標準の書式。
 *    ワークフローの Summary にも警告として載る）
 * 4. `$GITHUB_OUTPUT` に `dry_run=true`/`dry_run=false` を書く
 *    （呼び出し側の workflow はこの step の `outputs.dry_run` を読む）
 *
 * だけを行う。`scripts/__tests__/decide-publish-dry-run.test.mjs` はこのファイルを
 * 子プロセスとして実際に起動し、`$GITHUB_OUTPUT` に書かれた内容と stdout の
 * `::warning::` を検査する——`scripts/__tests__/run-db-tests.test.mjs` が
 * `run-db-tests.mjs` を子プロセスで起動して検査するのと同じ形。
 */
import { appendFileSync } from "node:fs";
import { decideDryRun } from "./publish-dry-run.mjs";

const eventName = process.env.EVENT_NAME ?? "";
const dryRunInput = process.env.DRY_RUN_INPUT;

const { dryRun, warnings } = decideDryRun({ eventName, dryRunInput });

for (const warning of warnings) {
  console.log(`::warning::${warning}`);
}

const outputLine = `dry_run=${dryRun}\n`;
const outputPath = process.env.GITHUB_OUTPUT;
if (outputPath) {
  appendFileSync(outputPath, outputLine);
} else {
  // $GITHUB_OUTPUT が無い環境（手元で直接叩いたときなど）でも、決まった値が
  // 見えなくなるのは避ける。GitHub Actions の実行では常に設定されている。
  console.log(`(GITHUB_OUTPUT 未設定のため標準出力へ) ${outputLine.trim()}`);
}

console.log(dryRun ? "判定: 予行（--dry-run）" : "判定: 本番 publish");

#!/usr/bin/env node
// `pnpm test:shard-files <scope> <i>/<n>`: vitest の `--shard` が割り当てるテストファイルを、走らせずに1行1ファイルで出す。
// JSON レポートは一時ディレクトリへ書かせる: 既定の `.vitest/json/output.json` は `.gitignore` に入っていないため。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  buildShardFilesVitestArgs,
  filesFromJsonReport,
  parseShardFilesArgs,
} from './test-shard-files-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const parsed = parseShardFilesArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    process.exitCode = 2;
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteroid-shard-files-'));
  const outputFile = path.join(dir, 'report.json');
  try {
    const result = spawnSync(
      'vitest',
      buildShardFilesVitestArgs({ scope: parsed.scope, shard: parsed.shard, outputFile }),
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    } catch {
      report = null;
    }
    const files = filesFromJsonReport(report, ROOT);
    if (files === null) {
      process.stderr.write(
        `test-shard-files: vitest の JSON レポートが読めなかった（exit ${String(result.status)}）。` +
          '一覧は出さない（0件と取り違えないため）。\n' +
          `${(result.stderr ?? '').split('\n').slice(-20).join('\n')}\n`,
      );
      process.exitCode = 3;
      return;
    }
    for (const f of files) process.stdout.write(`${f}\n`);
    process.stdout.write(
      `test-shard-files: ${parsed.scope} --shard=${parsed.shard} → ${files.length} ファイル\n`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();

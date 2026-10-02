#!/usr/bin/env node
/**
 * `codex app-server` のプロトコルの JSON Schema を、固定した版の `@openai/codex` から
 * 生成して `packages/core/codex-schema/<版>/` に置く（#486 M7 S6）。
 *
 *   pnpm --filter @alteroid/core codex:schema          # 書き出す
 *   pnpm --filter @alteroid/core codex:schema --check  # コミット済みと一致するかだけ見る
 *
 * **なぜ置くのか。** `src/codex-protocol.ts` は alteroid が使う欄だけを手で写した薄い型で、
 * それが本物のプロトコルとずれていないことを `src/codex-protocol.test.ts` が
 * このスキーマと突き合わせて確かめる。突き合わせの相手がネットワークや
 * インストール済みの codex の有無に左右されないよう、スキーマ自体をリポジトリに置く。
 *
 * **何を置くか。** `generate-json-schema` が吐く全体（約 4.4MB・39 ファイル＋ v1/v2 の個別ファイル）
 * のうち、束ねられた `codex_app_server_protocol.schemas.json` の1本だけ（約 0.7MB）。
 * `ClientRequest` / `ServerRequest` / `ServerNotification` / `ClientNotification` /
 * `JSONRPCMessage` と、v2 の全定義（`definitions.v2`）がこの1本に入っており、
 * 他のファイルはどれもこの束の部分集合である。**中身は1バイトも加工しない**（抜粋も整形もしない）
 * ので、再生成の結果と `diff` で一致する。
 *
 * **版は `@openai/codex` の `package.json` から読む**（このファイルに書かない）。版を上げたら
 * 新しい版のディレクトリが増える。古い版のディレクトリはこの道具が消す。
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const schemaRoot = resolve(here, '../codex-schema');
const BUNDLE = 'codex_app_server_protocol.schemas.json';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('@openai/codex/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
const bin = join(dirname(pkgPath), pkg.bin.codex);

const check = process.argv.includes('--check');
const tmp = mkdtempSync(join(tmpdir(), 'codex-schema-'));
try {
  execFileSync(process.execPath, [bin, 'app-server', 'generate-json-schema', '--out', tmp], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const generated = readFileSync(join(tmp, BUNDLE));
  const dest = join(schemaRoot, version);
  if (check) {
    let committed;
    try {
      committed = readFileSync(join(dest, BUNDLE));
    } catch {
      committed = null;
    }
    if (committed === null || !committed.equals(generated)) {
      process.stderr.write(
        `codex-schema/${version}/${BUNDLE} が ${version} の生成結果と一致しない。` +
          '`pnpm --filter @alteroid/core codex:schema` で再生成すること\n',
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`codex-schema/${version}/${BUNDLE}: 一致\n`);
    }
  } else {
    mkdirSync(schemaRoot, { recursive: true });
    for (const entry of readdirSync(schemaRoot)) {
      rmSync(join(schemaRoot, entry), { recursive: true, force: true });
    }
    mkdirSync(dest, { recursive: true });
    cpSync(join(tmp, BUNDLE), join(dest, BUNDLE));
    process.stdout.write(`codex-schema/${version}/${BUNDLE}: ${generated.length} bytes\n`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

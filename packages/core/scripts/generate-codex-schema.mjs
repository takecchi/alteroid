#!/usr/bin/env node
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

// 置いたスキーマと生成結果の比べは持たない: 再生成して `git diff` を読めば同じことが分かり、版を上げる手順もそうしている。
const tmp = mkdtempSync(join(tmpdir(), 'codex-schema-'));
try {
  execFileSync(process.execPath, [bin, 'app-server', 'generate-json-schema', '--out', tmp], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const generated = readFileSync(join(tmp, BUNDLE));
  const dest = join(schemaRoot, version);
  mkdirSync(schemaRoot, { recursive: true });
  for (const entry of readdirSync(schemaRoot)) {
    rmSync(join(schemaRoot, entry), { recursive: true, force: true });
  }
  mkdirSync(dest, { recursive: true });
  cpSync(join(tmp, BUNDLE), join(dest, BUNDLE));
  process.stdout.write(`codex-schema/${version}/${BUNDLE}: ${generated.length} bytes\n`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

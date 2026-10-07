#!/usr/bin/env node
// 素の `shadcn add` を打たずここで包む: 部品が `from "cn"` で npm の無関係な `cn` パッケージを依存へ足すため
import { spawnSync } from 'node:child_process';
// グローバルに頼らない: ESLint の既定の環境に Node の大域が無いため
import console from 'node:console';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const uiDir = path.join(packageDir, 'src/components/ui');
const packageJsonPath = path.join(packageDir, 'package.json');

const names = process.argv.slice(2).filter((arg) => arg !== '--');
if (names.length === 0) {
  console.error('使い方: pnpm --filter @alteroid/ui shadcn:add <部品の名前...>');
  process.exit(2);
}

const hadCn = 'cn' in (JSON.parse(readFileSync(packageJsonPath, 'utf8')).dependencies ?? {});

const add = spawnSync('pnpm', ['exec', 'shadcn', 'add', ...names, '--yes'], {
  cwd: packageDir,
  stdio: 'inherit',
});
if (add.status !== 0) {
  console.error(`shadcn add が失敗した（exit ${add.status}）。後処理はしていない。`);
  process.exit(add.status ?? 1);
}

const fixed = [];
for (const file of readdirSync(uiDir)) {
  if (!file.endsWith('.tsx')) continue;
  const full = path.join(uiDir, file);
  const before = readFileSync(full, 'utf8');
  const after = before.replaceAll('from "cn"', 'from "@/lib/utils"');
  if (after !== before) {
    writeFileSync(full, after);
    fixed.push(file);
  }
}
console.log(`import を直した: ${fixed.length === 0 ? 'なし' : fixed.join(', ')}`);

const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
if (!hadCn && pkg.dependencies && 'cn' in pkg.dependencies) {
  delete pkg.dependencies.cn;
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log('package.json から cn を消した。根で `pnpm install` を打ち直すこと。');
}

const format = spawnSync('pnpm', ['exec', 'prettier', '--write', uiDir], {
  cwd: packageDir,
  stdio: 'inherit',
});
if (format.status !== 0) process.exit(format.status ?? 1);

console.log(
  '残りは手で: src/components/ui/index.ts へ1行足す / `git diff --stat pnpm-lock.yaml` を見る',
);

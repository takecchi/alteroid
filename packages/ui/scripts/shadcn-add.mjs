#!/usr/bin/env node
/**
 * `shadcn add` の包み。`pnpm --filter @alteroid/ui shadcn:add <部品の名前...>`。
 *
 * ## なぜ素の `shadcn add` を打たないか
 *
 * この repo の `packages/ui` で `shadcn add`（shadcn 4.21.0。2026-09-29 実測）を打つと、
 * `shadcn info` の Resolved Paths は正しく `src/lib/utils` を指しているのに、吐かれる部品は
 * **`import { cn } from "cn"` になり、npm の無関係な `cn` パッケージを依存へ足す。**
 * 型検査とテストは落ちる（`cn` の中身が違う）が、依存の追加は `package.json` と
 * `pnpm-lock.yaml` に黙って残る。
 *
 * ここでは CLI をそのまま呼んだあと、次の3つだけを直す:
 * 1. `src/components/ui/*.tsx` の `from "cn"` を `from "@/lib/utils"` へ
 * 2. `package.json` の `dependencies.cn` を消す（足される前に無かったときだけ）
 * 3. 吐かれた部品を prettier で整える（CI の `format:check` を通すため）
 *
 * **`pnpm-lock.yaml` は直さない。** CLI の依存の入れ直しで、無関係な推移的依存の版が
 * 動くことがある（実測: `@jridgewell/sourcemap-codec` 1.5.5 → 1.6.0）。それが要る
 * 変化かどうかはここでは判定できないので、最後に `git diff --stat pnpm-lock.yaml` を
 * 見るよう出力する。
 *
 * 足した部品は `src/components/ui/index.ts` へ1行足すこと（ここでは足さない——
 * 何を公開するかは足す人が決める）。
 */
import { spawnSync } from 'node:child_process';
// グローバルに頼らない（`scripts/verify.mjs` と同じ作法。ESLint の既定の環境に Node の大域が無い）。
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

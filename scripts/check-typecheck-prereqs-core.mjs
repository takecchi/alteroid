// 前提の生成物の一覧は各 workspace の package.json の exports の `types` から導出する: ベタ書きすると exports を足したときに一覧が黙って陳腐化するため。
// 対象は `types` が dist/ を指す workspace 全部: core だけだと、storage-fs / storage-pg の dist が無い daemon の typecheck が TS2307 で落ちる（#6613 の実測）。
// canon.ts は core の `write-canon`、dist/ は各 package の tsup が作る。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const CANON_PATH = 'packages/core/src/generated/canon.ts';
const CORE_NAME = '@alteroid/core';

function listWorkspaceDirs(root) {
  const dirs = [];
  for (const parent of ['packages', 'apps']) {
    let names;
    try {
      names = readdirSync(join(root, parent));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (existsSync(join(root, parent, name, 'package.json'))) dirs.push(`${parent}/${name}`);
    }
  }
  return dirs;
}

// 戻り値: { path, pkg }[]（path は root からの相対、pkg は所有する package 名）
export function findMissingTypecheckPrereqs(root) {
  const missing = [];
  for (const dir of listWorkspaceDirs(root)) {
    const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    for (const entry of Object.values(pkg.exports ?? {})) {
      const types = entry && typeof entry.types === 'string' ? entry.types : null;
      if (types === null || !types.startsWith('./dist/')) continue;
      const path = join(dir, types);
      if (!existsSync(join(root, path))) missing.push({ path, pkg: pkg.name });
    }
  }
  if (!existsSync(join(root, CANON_PATH))) missing.unshift({ path: CANON_PATH, pkg: CORE_NAME });
  return missing;
}

export function buildCommandFor(missing) {
  const names = [...new Set(missing.map((m) => m.pkg))];
  return `pnpm ${names.map((n) => `-F ${n}`).join(' ')} build`;
}

export function formatMissingMessage(missing) {
  return [
    `check-typecheck-prereqs: 先に \`${buildCommandFor(missing)}\` を実行してください（write-canon と tsup が生成物を作ります）。`,
    `typecheck の前提の生成物が ${missing.length} 件無い:`,
    ...missing.map((m) => `  ${m.path}`),
  ].join('\n');
}

// 前提の生成物の一覧は `packages/core/package.json` の exports の `types` から導出する: ベタ書きすると exports を足したときに一覧が黙って陳腐化するため。
// canon.ts は `write-canon`、dist/ は tsup が作る（どちらも `pnpm -F @alteroid/core build`）。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CANON_PATH = 'packages/core/src/generated/canon.ts';
export const BUILD_COMMAND = 'pnpm -F @alteroid/core build';

export function listCoreTypesFiles(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8'));
  const files = [];
  for (const entry of Object.values(pkg.exports ?? {})) {
    if (entry && typeof entry.types === 'string') {
      files.push(join('packages/core', entry.types));
    }
  }
  return files;
}

export function findMissingTypecheckPrereqs(root) {
  return [CANON_PATH, ...listCoreTypesFiles(root)].filter((p) => !existsSync(join(root, p)));
}

export function formatMissingMessage(missing) {
  return [
    `check-typecheck-prereqs: 先に \`${BUILD_COMMAND}\` を実行してください（write-canon と tsup が生成物を作ります）。`,
    `typecheck の前提の生成物が ${missing.length} 件無い:`,
    ...missing.map((p) => `  ${p}`),
  ].join('\n');
}

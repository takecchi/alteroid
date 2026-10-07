import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

// `readdirSync` で自前に歩かず `listGitScannableFiles` に寄せる: 自前の除外だと `.gitignore` 済みの `.scratch/` の中まで読み、commit されないファイルで赤になるため。
// `excludeDirs` の絞り込みは残す: `.vite` は `.gitignore` に入っていないため。
// 作業ツリーに在るものだけに絞る: 追跡済みで消えたファイルを読みに行って ENOENT で落ちないようにするため。
export function collectRepoFiles(root: string, excludeDirs: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const file of listGitScannableFiles({ cwd: root }) as string[]) {
    if (file.split('/').some((segment) => excludeDirs.has(segment))) continue;
    if (!existsSync(path.join(root, file))) continue;
    out.push(file);
  }
  return out;
}

import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

// `readdirSync` で自前に歩かず `listGitScannableFiles` に寄せる: 自前の除外だと `.gitignore` 済みの `.scratch/` の中まで読み、commit されないファイルで赤になるため。
// `.vite` だけは関数の中で除く: `.gitignore` に入っていないため。他の生成物（node_modules・dist・build・`.react-router`）は git が既に出さない。
// 作業ツリーに在るものだけに絞る: 追跡済みで消えたファイルを読みに行って ENOENT で落ちないようにするため。
export function collectRepoFiles(root: string): string[] {
  const out: string[] = [];
  for (const file of listGitScannableFiles({ cwd: root }) as string[]) {
    if (file.split('/').includes('.vite')) continue;
    if (!existsSync(path.join(root, file))) continue;
    out.push(file);
  }
  return out;
}

import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

/**
 * repo 全体を走査する歯が対象を集めるときの一覧（#2111）。リポジトリ根からの相対パス
 * （`/` 区切り）を返す。
 *
 * **一覧は `listGitScannableFiles`（`git ls-files -co --exclude-standard`、#1817）に
 * 寄せてある。** 以前は `conversation-window-single-source.test.ts` /
 * `journal-store-with-contract-registry.test.ts` / `workspace-test-scripts.test.ts` の
 * 3本が、それぞれ `readdirSync` で根から自前で歩く同じ関数の写しを持っていた。自前の
 * 除外は `EXCLUDE_DIRS` だけなので、`.gitignore` 済みの `.scratch/`（作業者が一時
 * ファイルを置く場所）の中まで読み、commit されないファイルで赤になった（#2111 の実測）。
 *
 * - `excludeDirs` の絞り込みは残す。`.vite` は `.gitignore` に入っていないので、寄せた
 *   だけでは以前の除外と同じにならない
 * - 追跡済みで作業ツリーから消えたファイルは `git ls-files -c` に出るので、在るものだけに
 *   絞る（読みに行って ENOENT で落ちないように）
 */
export function collectRepoFiles(root: string, excludeDirs: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const file of listGitScannableFiles({ cwd: root }) as string[]) {
    if (file.split('/').some((segment) => excludeDirs.has(segment))) continue;
    if (!existsSync(path.join(root, file))) continue;
    out.push(file);
  }
  return out;
}

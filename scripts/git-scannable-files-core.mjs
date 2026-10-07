// 追跡済みだけ（`git ls-files`）にしない: 新規ファイルが手元の検査に入らず、`git add` して push した後の CI で初めて赤くなるため。
// シンボリックリンクの重複は畳まない: 重複排除が要る呼び出し元が自前で足す。

import { execFileSync } from 'node:child_process';

export function listGitScannableFiles(options = {}) {
  const { cwd, pathspec } = options;
  const args = ['ls-files', '-co', '--exclude-standard', '-z'];
  if (pathspec && pathspec.length > 0) {
    args.push('--', ...pathspec);
  }
  const out = execFileSync('git', args, {
    cwd,
    maxBuffer: 1024 * 1024 * 64,
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0);
}

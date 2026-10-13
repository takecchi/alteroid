import path from 'node:path';

import { isManagerScratchDirName } from './unpushed-work.js';

/** 担当1本あたりに覚える、git を打った場所の数の上限。 */
export const GIT_DIR_HINTS_MAX = 64;

export function isSameOrInside(target: string, dir: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** `/tmp/mgr-<16進>…` の決まりの作業場の下か。そこは片付け（`scratch-sweep.ts`）が扱う。 */
export function isUnderManagerScratchDir(target: string): boolean {
  if (!isSameOrInside(target, '/tmp')) return false;
  const first = path.relative('/tmp', path.resolve(target)).split(path.sep)[0] ?? '';
  return isManagerScratchDirName(first);
}

/**
 * Bash のコマンド文字列から、git を実際に打った場所（ディレクトリ）を取り出す。
 *
 * 作業場が決まり（`/tmp/mgr-<委譲 id の頭>`）の外にあっても、未 push の観測・退避 ref の探す先に足すため。
 * 見るのは次の3つで、`&&` `||` `;` `|` と改行で区切った部分を順にたどる。
 * - 部分の頭の場所: フックが渡した `cwd`。`cd <dir>` があれば、それ以降の部分はその先
 * - `git` を打った部分の、その時点の場所
 * - `git -C <dir>` の先（その時点の場所からの相対も解く）
 * 引用符・変数展開・`~` は解かない（解けない `cd` の先は以降を捨てる）: 誤った場所を足すより、足さないほうが安全なため。取りこぼしは今の決まりの探索が拾う。
 */
export function gitDirsFromBashCommand(command: string, cwd: string | undefined): string[] {
  const found: string[] = [];
  let current = cwd !== undefined && path.isAbsolute(cwd) ? cwd : undefined;
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const words = stripPrefixes(segment.trim().split(/\s+/).filter(Boolean));
    const head = words[0];
    if (head === undefined) continue;
    if (head === 'cd') {
      current = resolveDir(current, words[1]);
      continue;
    }
    if (basenameOf(head) !== 'git') continue;
    let dir = current;
    for (let i = 1; i < words.length; i += 1) {
      const word = words[i] ?? '';
      if (word === '-C') {
        dir = resolveDir(dir, words[i + 1]);
        i += 1;
        continue;
      }
      // `-C` 以外の大域オプションは値ごと飛ばし、サブコマンドに着いたら止める
      if (word === '-c' || word === '--git-dir' || word === '--work-tree') {
        i += 1;
        continue;
      }
      if (!word.startsWith('-')) break;
    }
    if (dir !== undefined && !found.includes(dir)) found.push(dir);
  }
  return found;
}

function resolveDir(base: string | undefined, target: string | undefined): string | undefined {
  if (target === undefined || target.length === 0) return undefined;
  if (/[~$`"'*?]/.test(target) || target === '-') return undefined;
  if (path.isAbsolute(target)) return path.normalize(target);
  return base === undefined ? undefined : path.resolve(base, target);
}

function basenameOf(token: string): string {
  const at = token.lastIndexOf('/');
  return at === -1 ? token : token.slice(at + 1);
}

const TIMEOUT_OPTIONS_WITH_VALUE = new Set(['-k', '-s', '--kill-after', '--signal']);

// 先頭の `NAME=value` と `timeout <オプション> <秒>` を外す（`outward-commands.ts` と同じ形）
function stripPrefixes(tokens: readonly string[]): string[] {
  let rest = [...tokens];
  while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0] ?? '')) rest = rest.slice(1);
  if (basenameOf(rest[0] ?? '') === 'timeout') {
    rest = rest.slice(1);
    while ((rest[0] ?? '').startsWith('-')) {
      rest = rest.slice(TIMEOUT_OPTIONS_WITH_VALUE.has(rest[0] ?? '') ? 2 : 1);
    }
    rest = rest.slice(1);
  }
  return rest;
}

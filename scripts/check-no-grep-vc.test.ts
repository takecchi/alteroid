import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

// 挙動ではなく書き方を測る: CI（ubuntu-latest）には shim が無く `grep -vc` が正しい値を返すため、挙動を測る歯は手元でだけ赤くなる。
// `AGENTS.md` と `.claude/skills/grep-counting/SKILL.md` は走査しない: 欠陥を説明する文が `grep -vc` を含み、危険を書き残すことを禁じる歯は歯が無いより悪いため。

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const EXCLUDED = [
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/skills/grep-counting/SKILL.md',
  'scripts/check-no-grep-vc.test.ts',
];

const SEPARATORS = new Set(['|', '||', '&&', ';', '&', '(', ')', '{', '}', '`', '|&']);

const SAFE_PREFIXES = new Set(['command', 'git', 'exec', 'builtin']);

// パターンより後ろに置かれたオプションも集める: `grep -v 'x' -c` は GNU も shim も `-c` として解釈するため。
export function hasGrepVc(line: string): boolean {
  const tokens = line.split(/\s+/).filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token !== 'grep' && token !== 'ugrep') continue;
    const previous = i > 0 ? tokens[i - 1] : undefined;
    if (previous !== undefined && SAFE_PREFIXES.has(previous)) continue;

    let short = '';
    const long = new Set<string>();
    for (let j = i + 1; j < tokens.length; j++) {
      const next = tokens[j];
      if (next === undefined) break;
      if (SEPARATORS.has(next) || next === '--') break;
      if (next.startsWith('--')) {
        const name = next.slice(2).split('=')[0];
        if (name !== undefined) long.add(name);
      } else if (next.startsWith('-') && next.length > 1) {
        short += next.slice(1);
      }
    }
    const invert = short.includes('v') || long.has('invert-match');
    const count = short.includes('c') || long.has('count');
    if (invert && count) return true;
  }
  return false;
}

export function scannableFiles(root: string = ROOT): string[] {
  return (listGitScannableFiles({ cwd: root }) as string[]).filter((p) => !EXCLUDED.includes(p));
}

describe('-v と -c を併せた grep', () => {
  it('壊れる書き方を全部見つける', () => {
    const broken = [
      "printf 'a\\nb' | grep -vc 'x'",
      "grep -cv 'x' file",
      "grep -v -c 'x' file",
      "grep -c -v 'x' file",
      "grep -rvc 'x' .",
      "grep --invert-match --count 'x' file",
      "grep -v --count 'x' file",
      "grep --invert-match -c 'x' file",
      "grep -v 'x' -c",
      "cat f | grep -vc 'x' | wc -l",
    ];
    for (const line of broken) expect(hasGrepVc(line), line).toBe(true);
  });

  it('壊れない書き方は見逃す', () => {
    const fine = [
      "grep -c 'x' file",
      "grep -v 'x' file",
      "grep -v 'x' | wc -l",
      "command grep -vc 'x' file",
      "git grep -vc 'x'",
      "rg -vc 'x'",
      "grep -c 'x' | grep -v 'y'",
      "grep -F -- '-vc' file",
      'echo "grep -v" && echo "-c"',
    ];
    for (const line of fine) expect(hasGrepVc(line), line).toBe(false);
  });

  it('走査対象から欠陥を説明する文書と自分自身が除かれている', () => {
    const files = scannableFiles();
    for (const excluded of EXCLUDED) expect(files).not.toContain(excluded);
  });

  it('追跡ファイルのどこにも書かれていない', () => {
    const files = scannableFiles();
    expect(files.length).toBeGreaterThan(100);

    const hits: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(path.join(ROOT, file), 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line !== undefined && hasGrepVc(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(
      hits,
      `-v と -c を併せた grep は件数を1少なく返す。grep -v … | wc -l に分けること`,
    ).toEqual([]);
  });
});

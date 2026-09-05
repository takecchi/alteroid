import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * **`-v` と `-c` を併せた `grep` を repo に書かせない歯**。
 *
 * ## 何を防いでいるか
 *
 * この器の `grep` は Claude Code が入れる shim（ugrep）で、**`-v` と `-c` を
 * 併せたときだけ、入力の末尾に改行が無いと件数が1少なくなる**。返るのは
 * `max(正しい件数 − 1, 0)` で、**誤差は必ず 0 の側へ倒れる** — つまり
 * 「該当なし」「問題なし」を*作る*向きにしか壊れない。`-c` 単独は正しく、
 * `-v` 単独（行を出す側）も正しいので、**「`-c` が合うから `-vc` も合う」と
 * 読むと踏む**。詳細と実測は `AGENTS.md`「静かに失敗する道具」の6番目。
 *
 * ## なぜ「挙動」ではなく「書き方」を測るか
 *
 * 素直な歯は「shim の `grep -vc` が1少なく数えること」を実際に起こして測る形
 * だが、**それは器が入れ替わった瞬間に赤くなる**。しかも `pnpm test` が実際に
 * 走る場所（CI の `ubuntu-latest`）には shim が無く、そこでは `grep -vc` は
 * **正しい**値を返す（実測 2026-09-06、`GNU grep 3.11`）。⟹ 挙動を測る歯は
 * **CI では当たらず、手元でだけ赤くなる**。歯として逆立ちしている。
 *
 * **だからここが測るのは「repo の中にこの書き方が無いこと」だけである。**
 * 器に依存せず、CI でも当たり、次に誰かが書いた時点で止まる。
 *
 * ## 守っていないもの（ここは正直に線を引く）
 *
 * - **`AGENTS.md` は走査しない。** この欠陥を説明する文そのものが
 *   `grep -vc` を含むためで、**危険を書き残すことを禁じる歯は、歯が無いより悪い**。
 *   （`CLAUDE.md` は `AGENTS.md` への symlink なので `git ls-files` に別名で
 *   挙がるが、中身は同じものである）
 * - **この検査自身も走査しない**（下の fixture が引っかかるため）
 * - **行を跨いだ `grep` の呼び**（`\` で継続した形）は見ない
 * - **`command grep` / `/usr/bin/grep` / `/bin/grep` / `git grep` / `rg` は許す。**
 *   どれも「どの実装が走るか」が呼び手から一意に決まっており、実際に正しく数える
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 走査しないパス。理由は上の doc に書いてある。 */
export const EXCLUDED = ['AGENTS.md', 'CLAUDE.md', 'scripts/check-no-grep-vc.test.ts'];

/** シェルとして「そこでコマンドが切れる」と読むトークン。 */
const SEPARATORS = new Set(['|', '||', '&&', ';', '&', '(', ')', '{', '}', '`', '|&']);

/** `grep` の呼びとして数えない前置き（どの実装が走るか一意に決まるもの）。 */
const SAFE_PREFIXES = new Set(['command', 'git', 'exec', 'builtin']);

/**
 * 1行の中から「`-v` と `-c` を併せた `grep`」の呼びを探し、見つかったら true。
 *
 * `grep` のトークンから始めて、シェルの区切りに当たるまでの範囲を1つの呼びとみなし、
 * その中のオプションを集める。**パターンより後ろに置かれたオプションも集める** —
 * `grep -v 'x' -c` は GNU も shim も `-c` として解釈するためである。`--` から先は
 * オプションではないので、そこで集めるのをやめる。
 */
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

/** 追跡ファイルのうち走査する対象。`git ls-files -z` が挙げるものだけを見る。 */
export function scannableFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return listed
    .split('\0')
    .filter((p) => p.length > 0)
    .filter((p) => !EXCLUDED.includes(p));
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

  it('追跡ファイルのどこにも書かれていない', () => {
    const files = scannableFiles();
    // 「走査対象が0件なので緑」を緑と読まないための足場。
    expect(files.length).toBeGreaterThan(100);

    const hits: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(path.join(ROOT, file), 'utf8');
      } catch {
        continue; // 追跡されているが読めないもの（symlink の切れ端など）は飛ばす
      }
      if (text.includes('\0')) continue; // バイナリ
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

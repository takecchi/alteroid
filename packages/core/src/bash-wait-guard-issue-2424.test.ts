import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * #2424 — `computeOutsideQuoteMask` がシェルのコメント（語頭の `#` から行末まで）を知らず、
 * コメントの中の `-t '` / `--subject '` を開き引用符と読んでいた。次の行の本物の
 * `gh pr merge --delete-branch` まで値として潰れ、素通しになっていた。
 * bash はコメントの中を実行せず、引用符も開かない。
 */
const REAL_MERGE = "gh pr merge 2 --match-head-commit abc --delete-branch # '";

function formOf(command: string): string | undefined {
  const v = inspectBashCommand(command);
  return v.blocked ? v.form : undefined;
}

describe('#2424: コメントの中の引用符は開かない', () => {
  it.each([
    ['コメントの中の -t が開く引用符', `echo hi # -t 'x\n${REAL_MERGE}`],
    ['コメントの中の --subject が開く引用符', `gh pr view 1 # --subject 'x\n${REAL_MERGE}`],
    ['行頭のコメント', `# -t 'x\n${REAL_MERGE}`],
    ['; の直後のコメント', `echo hi;# -t 'x\n${REAL_MERGE}`],
    ['コメントの中の二重引用符', `echo hi # --subject "x\n${REAL_MERGE}`],
    ['コメントの中の ; と |', `echo hi # a; b | c -t 'x\n${REAL_MERGE}`],
  ])('%s: 弾く', (_label, command) => {
    expect(formOf(command)).toBe('gh-pr-merge-delete-branch');
  });

  it('元の形（コメントの無い1行）も弾く', () => {
    expect(formOf('gh pr merge 2 --match-head-commit abc --delete-branch')).toBe(
      'gh-pr-merge-delete-branch',
    );
  });
});

describe('#2424: コメントではない # は、これまでどおり（偽陽性にしない）', () => {
  it.each([
    [
      '値の中の # （単一引用符）',
      "gh pr merge 2 --match-head-commit abc --subject '#x --delete-branch'",
    ],
    [
      '値の中の # （二重引用符）',
      'gh pr merge 2 --match-head-commit abc --subject "a #x --delete-branch"',
    ],
    ['$# は語頭ではない', `echo $# -t 'x\n${REAL_MERGE}`],
    ['${#x} は語頭ではない', `echo \${#x} -t 'x\n${REAL_MERGE}`],
    ['foo#bar は語頭ではない', `echo foo#bar -t 'x\n${REAL_MERGE}`],
    ['a=#x は語頭ではない', `a=#x; echo -t 'x\n${REAL_MERGE}`],
    ['エスケープした空白の直後の # は語頭ではない', `echo a\\ #b -t 'x\n${REAL_MERGE}`],
    ['閉じた引用符の直後の # は語頭ではない', `echo 'a'#b -t 'x\n${REAL_MERGE}`],
    [
      'コメントだけの行の後の、--delete-branch の無い正しいマージ',
      "# note: don't use -t 'x\ngh pr merge 2 --match-head-commit abc",
    ],
  ])('%s: 通す', (_label, command) => {
    expect(inspectBashCommand(command).blocked).toBe(false);
  });

  it('コメントの中の区切りの後ろの -d は、これまでどおり区間に入れない扱い（実行されない -d を弾かない）', () => {
    expect(inspectBashCommand('gh pr merge 2 --match-head-commit abc # ; -d').blocked).toBe(false);
  });
});

describe('#2424 の判定が、長い入力で2乗にならない', () => {
  const cases: ReadonlyArray<[string, (n: number) => string, number]> = [
    ['コメントの繰り返し', (n) => `${"echo hi # -t 'x\n".repeat(n)}${REAL_MERGE}`, 1000],
    ['語頭でない # の繰り返し', (n) => `${'echo a#b $# '.repeat(n)}x`, 1000],
  ];
  for (const [label, makeInput, n] of cases) {
    it(`${label}が線形に終わる`, () => {
      expectNotSuperlinear((command: string) => inspectBashCommand(command), makeInput, { n });
    });
  }
});

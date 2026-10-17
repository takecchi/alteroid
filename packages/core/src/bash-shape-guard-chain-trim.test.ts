import { describe, expect, it } from 'vitest';

import {
  BASH_SHAPE_CONTINUE_NOTE,
  BASH_SHAPE_SUMMARIES,
  bashShapePromptLines,
  inspectBashShape,
  type BashShapeForm,
} from './bash-shape-guard.js';
import { WAIT_GUARD_SUMMARIES, waitGuardPromptLines } from './bash-wait-guard.js';

function formOf(command: string): string | undefined {
  const v = inspectBashShape(command);
  return v.blocked ? v.form : undefined;
}

describe('`;` で2つ以上のコマンドを繋ぐ形は chain で断る（#5017）', () => {
  it.each([
    'echo a; echo b',
    'ls; pwd',
    'pnpm test; echo done',
    'echo a ; echo b ; echo c',
    "bash -c 'echo a; echo b'",
    'echo "$(ls; pwd)"',
  ])('%j は chain で断り、1つずつ順に呼ぶよう勧めて続けてよいと締める', (command) => {
    const v = inspectBashShape(command);
    expect(v.blocked && v.form).toBe('chain');
    if (!v.blocked) return;
    expect(v.reason).toContain('1つのコマンドだけを打ち');
    expect(v.reason).toContain('前の結果を見てから次を打つ');
    expect(v.reason.endsWith(BASH_SHAPE_CONTINUE_NOTE)).toBe(true);
  });

  it.each([
    // 引用符の中・注釈の中
    'git commit -m "a; b"',
    "echo 'a; b'",
    'echo "a; b" | grep b',
    'echo hi # a; b',
    // `\;`（find -exec）
    'find . -name "*.ts" -exec grep -l foo {} \\;',
    'find . -type f -exec echo {} \\; -print',
    // 制御構文の中の `;`（既知の穴: 制御構文が在るコマンドは丸ごと断らない）
    'case $x in a) echo a;; b) echo b;; esac',
    'for f in a b; do echo $f; done',
    'if [ -f x ]; then echo y; fi',
    'while true; do break; done',
    'until test -f x; do break; done',
    'f() { echo a; }',
    'for ((i=0; i<3; i++)); do echo $i; done',
    // `$((…))`・`[[ … ]]` の中
    'echo $((x;y))',
    '[[ a == b; ]] && echo ok',
    // 末尾の `;` は繋いでいない
    'echo a;',
    'echo a &&  echo b',
  ])('%j は断らない', (command) => {
    expect(inspectBashShape(command)).toEqual({ blocked: false });
  });

  it('cd の後ろの `;` は、より具体的な cd-chain を返す', () => {
    expect(formOf('cd x; ls')).toBe('cd-chain');
  });

  it('管の最後が head・tail の形のほうが先に当たる（直す道がはっきりしている）', () => {
    expect(formOf('git log | head; echo a')).toBe('pipe-trim');
  });
});

describe('cd の後ろに別のコマンドを続ける形は cd-chain で断る（#5017）', () => {
  it.each(['cd x && make', 'cd x; ls', 'cd x | cat', 'cd /x && pnpm test'])(
    '%j は cd-chain',
    (command) => {
      expect(formOf(command)).toBe('cd-chain');
    },
  );

  it.each(['cd /x', 'cd x', 'pnpm -C /x test', 'make -C /x', 'ls && cd /x'])(
    '%j は断らない',
    (command) => {
      expect(inspectBashShape(command)).toEqual({ blocked: false });
    },
  );
});

describe('管の最後の段が head・tail の形は pipe-trim で断る（#5017）', () => {
  it.each([
    'git log | head -20',
    'pnpm test | tail -50',
    'gh pr list | head',
    'ls | grep a | tail -n 5',
    'cat f | tail',
    'timeout 60 pnpm test | tail -n 20',
    'ls && git log | tail',
    "bash -c 'git log --oneline | head -5'",
  ])('%j は pipe-trim で断る', (command) => {
    const v = inspectBashShape(command);
    expect(v.blocked && v.form).toBe('pipe-trim');
    if (!v.blocked) return;
    expect(v.reason).toContain('終了コード');
    expect(v.reason).toContain('全文をファイルに残す');
    expect(v.reason).toContain('git log -n 20');
    expect(v.reason).toContain('--limit 20');
    expect(v.reason.endsWith(BASH_SHAPE_CONTINUE_NOTE)).toBe(true);
  });

  it('状態を変えるコマンドを管に渡す形は、pipe-masks-exit を先に返す', () => {
    expect(formOf('git merge origin/main | tail -n 5')).toBe('pipe-masks-exit');
  });

  it.each([
    // 待ちの歯の受け持ち
    'tail -f x.log',
    'cat x | tail -f',
    'cat x | tail --follow',
    'cat x | tail -F',
    'cat x | tail -n 5 -f',
    // 最後の段が head・tail でない
    'echo a | grep b',
    'git log | wc -l',
    'head -20 f',
    'tail -n 5 f',
    // 一番外側のコマンドだけを見る
    'x=$(ls | head -1)',
    'echo $(ls | tail -1)',
    'echo "$(ls | head -1)"',
    'echo `ls | head -1`',
    'git log | head -1 | wc -l',
    // 引用符・注釈の中
    'echo "a | head"',
    'echo a # b | head',
    // 各段の終了コードを自分で拾う形
    'pnpm test | tail\necho "${PIPESTATUS[0]}"',
  ])('%j は断らない', (command) => {
    expect(inspectBashShape(command)).toEqual({ blocked: false });
  });
});

describe('断る形の要約は、全部の形を網羅する（#5017）', () => {
  // 形の一覧。`BashShapeForm` に足したのにここへ書かないと、下の `satisfies` が typecheck で落ちる
  const ALL_FORMS = [
    'heredoc',
    'subst-heredoc',
    'redirect',
    'fd-dup',
    'pipe-stderr',
    'sed-in-place',
    'node-eval',
    'python-c',
    'perl-eval',
    'git-reset',
    'git-force-push',
    'git-rebase',
    'no-verify',
    'gh-merge-auto',
    'cd-git',
    'cd-chain',
    'chain',
    'pipe-trim',
    'pipe-masks-exit',
  ] as const satisfies readonly BashShapeForm[];

  it('形の歯の要約のキーが、形の一覧と過不足なく一致する', () => {
    expect(Object.keys(BASH_SHAPE_SUMMARIES).sort()).toEqual([...ALL_FORMS].sort());
    expect(Object.keys(BASH_SHAPE_SUMMARIES)).toHaveLength(ALL_FORMS.length);
  });

  it('形の歯の一覧は、形ごとに1行で、断る形と代わりの書き方を持つ', () => {
    const lines = bashShapePromptLines().split('\n');
    expect(lines).toHaveLength(ALL_FORMS.length);
    for (const form of ALL_FORMS) {
      const { shape, instead } = BASH_SHAPE_SUMMARIES[form];
      expect(shape.trim()).not.toBe('');
      expect(instead.trim()).not.toBe('');
      expect(lines).toContain(`- ${shape} → ${instead}`);
    }
  });

  it('待ちの歯の要約は、待ちの歯の形（5つ）を網羅する', () => {
    expect(Object.keys(WAIT_GUARD_SUMMARIES).sort()).toEqual(
      ['for-sleep', 'gh-run-watch-background', 'tail-f', 'until-sleep', 'while-sleep'].sort(),
    );
    expect(waitGuardPromptLines().split('\n')).toHaveLength(5);
  });
});
